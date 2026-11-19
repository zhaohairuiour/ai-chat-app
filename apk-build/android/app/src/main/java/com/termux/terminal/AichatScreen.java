package com.termux.terminal;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;

/**
 * Termux terminal-emulator 的宿主：把 pty 字节流喂进真正的 VT 屏幕模型，
 * 再把屏幕内容按行/按样式片段导出给 WebView 渲染。
 *
 * 与之前"行模型 + 正则猜进度"的做法不同，这里所有回车重绘、清屏、光标定位、
 * 交替屏都由 TerminalEmulator 按 VT100 语义处理，全屏程序（nano/top/less）也能正确显示。
 */
public final class AichatScreen extends TerminalOutput implements TerminalSessionClient {

    public interface Sink {
        void onScreen(JSObject data);
    }

    private static AichatScreen sCurrent;

    public static synchronized AichatScreen current() { return sCurrent; }

    public static synchronized AichatScreen create(int columns, int rows, Sink sink) {
        AichatScreen s = new AichatScreen();
        s.init(columns, rows, sink);
        sCurrent = s;
        return s;
    }

    public static synchronized void destroy() {
        AichatScreen s = sCurrent;
        sCurrent = null;
        if (s != null) s.stop();
    }

    private TerminalEmulator emulator;
    private TerminalSession session;
    private Sink sink;
    private volatile boolean dirty = true;
    private volatile boolean running;
    private int columns = 80;
    private int rows = 24;
    private String[] lastRows = new String[0];
    private int lastCursorRow = -1;
    private int lastCursorCol = -1;
    private Thread pump;

    private AichatScreen() {}

    private void init(int cols, int rws, Sink sink) {
        this.columns = Math.max(20, cols);
        this.rows = Math.max(8, rws);
        this.sink = sink;
        this.session = new TerminalSession();
        this.emulator = new TerminalEmulator(this, this.columns, this.rows, 1, 1, 4000, this);
        this.session.attachEmulator(emulator);
        this.lastRows = new String[this.rows];
        this.running = true;
        this.dirty = true;
        startPump();
    }

    public TerminalSession getSession() { return session; }

    public void setStdin(java.io.OutputStream out) { if (session != null) session.setStdin(out); }

    private void startPump() {
        pump = new Thread(() -> {
            while (running) {
                try { Thread.sleep(100); } catch (InterruptedException e) { break; }
                if (!dirty) continue;
                dirty = false;
                try {
                    JSObject ev = snapshot(false);
                    if (ev != null && sink != null) sink.onScreen(ev);
                } catch (Throwable ignored) {}
            }
        }, "aichat-screen-pump");
        pump.setDaemon(true);
        pump.start();
    }

    private void stop() {
        running = false;
        if (pump != null) pump.interrupt();
        pump = null;
        emulator = null;
        session = null;
    }

    /** pty 原始字节（含 ESC 序列）直接进屏幕模型 */
    public void feed(byte[] data, int length) {
        TerminalEmulator e = emulator;
        if (e == null) return;
        try {
            e.append(data, length);
            dirty = true;
        } catch (Throwable ignored) {}
    }

    public void resize(int cols, int rws) {
        TerminalEmulator e = emulator;
        if (e == null) return;
        columns = Math.max(20, cols);
        rows = Math.max(8, rws);
        lastRows = new String[rows];
        try { e.resize(columns, rows, 1, 1); } catch (Throwable ignored) {}
        dirty = true;
    }

    /** 全量快照（初次拉取 / 强制重绘） */
    public JSObject snapshot(boolean full) {
        TerminalEmulator e = emulator;
        if (e == null) return null;
        TerminalBuffer buffer = e.getScreen();
        if (buffer == null) return null;
        int cols = Math.min(e.getColumns(), buffer.mColumns);
        int rws = Math.min(e.getRows(), buffer.mScreenRows);

        JSArray lines = new JSArray();
        for (int r = 0; r < rws; r++) {
            String key = buildRowKey(buffer, r, cols);
            boolean changed = full || r >= lastRows.length || !key.equals(lastRows[r]);
            if (!changed) continue;
            if (r < lastRows.length) lastRows[r] = key;
            JSObject line = new JSObject();
            line.put("r", r);
            line.put("runs", buildRuns(buffer, r, cols));
            lines.put(line);
        }

        int cr = e.getCursorRow();
        int cc = e.getCursorCol();
        JSObject ev = new JSObject();
        ev.put("cols", cols);
        ev.put("rows", rws);
        ev.put("lines", lines);
        ev.put("cursorRow", cr);
        ev.put("cursorCol", cc);
        // TerminalEmulator 未暴露可见性开关，DECTCEM 关闭时按不可见处理
        ev.put("cursorVisible", e.getCursorStyle() != 0 ? true : isCursorRenderable());
        boolean metaChanged = full || cr != lastCursorRow || cc != lastCursorCol;
        ev.put("metaChanged", metaChanged);
        lastCursorRow = cr;
        lastCursorCol = cc;
        if (lines.length() == 0 && !metaChanged) return null;
        return ev;
    }

    private boolean isCursorRenderable() { return true; }

    private String buildRowKey(TerminalBuffer buffer, int r, int cols) {
        TerminalRow row = rowOf(buffer, r);
        if (row == null) return "";
        StringBuilder sb = new StringBuilder(cols * 2);
        for (int col = 0; col < cols; col++) {
            int idx = row.findStartOfColumn(col);
            if (idx < 0 || idx >= row.mText.length) { sb.append(' '); continue; }
            char ch = row.mText[idx];
            if (ch == '\0') ch = ' ';
            long style = row.getStyle(col);
            sb.append(ch).append(':').append(TextStyle.decodeForeColor(style))
              .append(':').append(TextStyle.decodeBackColor(style))
              .append(':').append(TextStyle.decodeEffect(style) & TextStyle.CHARACTER_ATTRIBUTE_BOLD)
              .append(',');
        }
        return sb.toString();
    }

    private JSArray buildRuns(TerminalBuffer buffer, int r, int cols) {
        JSArray runs = new JSArray();
        TerminalRow row = rowOf(buffer, r);
        if (row == null) return runs;

        StringBuilder text = new StringBuilder();
        int runFg = -999, runBg = -999, runBold = -1;

        for (int col = 0; col < cols; col++) {
            int idx = row.findStartOfColumn(col);
            if (idx < 0 || idx >= row.mText.length) { appendCell(text, ' '); continue; }
            char ch = row.mText[idx];
            int cp = ch;
            if (Character.isHighSurrogate(ch) && idx + 1 < row.mText.length) {
                cp = Character.toCodePoint(ch, row.mText[idx + 1]);
            }
            if (cp == 0) cp = ' ';
            long style = row.getStyle(col);
            int fg = TextStyle.decodeForeColor(style);
            int bg = TextStyle.decodeBackColor(style);
            int bold = (TextStyle.decodeEffect(style) & TextStyle.CHARACTER_ATTRIBUTE_BOLD) != 0 ? 1 : 0;
            // COLOR_INDEX_* 是主题占位符（256 及以上），交给前端当默认色处理
            if (fg > 255) fg = -1;
            if (bg > 255) bg = -1;

            int width = WcWidth.width(cp);
            if (width <= 0) { text.appendCodePoint(cp); continue; }

            if (fg != runFg || bg != runBg || bold != runBold) {
                flushRun(runs, text, runFg, runBg, runBold);
                runFg = fg; runBg = bg; runBold = bold;
            }
            text.appendCodePoint(cp);
            if (width == 2) {
                col++;
                appendCell(text, ' ');
            }
        }
        flushRun(runs, text, runFg, runBg, runBold);
        return runs;
    }

    private void appendCell(StringBuilder sb, char c) { sb.append(c); }

    private void flushRun(JSArray runs, StringBuilder text, int fg, int bg, int bold) {
        if (text.length() == 0) return;
        if (fg < 0 && bg < 0 && bold == 0) {
            runs.put(text.toString());
        } else {
            JSObject run = new JSObject();
            run.put("t", text.toString());
            run.put("fg", fg);
            run.put("bg", bg);
            if (bold != 0) run.put("b", 1);
            runs.put(run);
        }
        text.setLength(0);
    }

    private TerminalRow rowOf(TerminalBuffer buffer, int externalRow) {
        try {
            int internal = buffer.externalToInternalRow(externalRow);
            if (internal < 0 || internal >= buffer.mLines.length) return null;
            return buffer.mLines[internal];
        } catch (Throwable t) {
            return null;
        }
    }

    // ---- TerminalOutput（模拟器回写客户端）----

    @Override
    public void write(byte[] data, int offset, int count) {
        if (session != null) session.write(data, offset, count);
    }

    @Override
    public void titleChanged(String oldTitle, String newTitle) {
        if (session != null) session.setTitle(newTitle);
    }

    @Override
    public void onCopyTextToClipboard(String text) {}

    @Override
    public void onPasteTextFromClipboard() {}

    @Override
    public void onBell() {}

    @Override
    public void onColorsChanged() { dirty = true; }

    // ---- TerminalSessionClient ----

    @Override
    public void onTextChanged(TerminalSession changedSession) { dirty = true; }

    @Override
    public void onTitleChanged(TerminalSession changedSession) {}

    @Override
    public void onSessionFinished(TerminalSession finishedSession) { dirty = true; }

    @Override
    public void onCopyTextToClipboard(TerminalSession session, String text) {}

    @Override
    public void onPasteTextFromClipboard(TerminalSession session) {}

    @Override
    public void onBell(TerminalSession session) {}

    @Override
    public void onColorsChanged(TerminalSession session) { dirty = true; }

    @Override
    public void onTerminalCursorStateChange(boolean state) { dirty = true; }

    @Override
    public void setTerminalShellPid(TerminalSession session, int pid) {}

    /** 光标形状（block/bar/underline），WebView 渲染用同一套块状光标 */
    @Override
    public Integer getTerminalCursorStyle() { return 0; }

    @Override
    public void logError(String tag, String message) {}

    @Override
    public void logWarn(String tag, String message) {}

    @Override
    public void logInfo(String tag, String message) {}

    @Override
    public void logDebug(String tag, String message) {}

    @Override
    public void logVerbose(String tag, String message) {}

    @Override
    public void logStackTraceWithMessage(String tag, String message, Exception e) {}

    @Override
    public void logStackTrace(String tag, Exception e) {}
}
