package com.termux.terminal;

import java.io.OutputStream;
import java.util.UUID;

/**
 * 极简 TerminalSession 替身。
 *
 * 原版 Termux 的 TerminalSession 依赖 JNI（libtermux.so）fork pty；本应用已经在 Java 层
 * 用 "script -q -e -c ..." 建立 pty，pty 的生命周期由 SandboxPlugin 持有，这里只需要
 * 承载 TerminalEmulator 并向 stdin 转发写操作，避免引入 NDK 编译。
 */
public class TerminalSession extends TerminalOutput {

    public final String mHandle = UUID.randomUUID().toString();

    private TerminalEmulator mEmulator;
    private OutputStream mStdin;
    private volatile boolean mRunning;
    private String mTitle = "";

    public TerminalEmulator getEmulator() { return mEmulator; }

    public void attachEmulator(TerminalEmulator emulator) { mEmulator = emulator; }

    public void setStdin(OutputStream stdin) { mStdin = stdin; }

    public void setRunning(boolean running) { mRunning = running; }

    public boolean isRunning() { return mRunning; }

    public String getTitle() { return mTitle; }

    public void setTitle(String title) { mTitle = title == null ? "" : title; }

    /** TerminalOutput 抽象方法：模拟器请求回写（如 CSI DA 应答、剪贴板请求）时转发到 stdin */
    @Override
    public void write(byte[] data, int offset, int count) {
        try {
            if (mStdin != null) {
                mStdin.write(data, offset, count);
                mStdin.flush();
            }
        } catch (Exception ignored) {}
    }

    @Override
    public void titleChanged(String oldTitle, String newTitle) { mTitle = newTitle == null ? "" : newTitle; }

    @Override
    public void onCopyTextToClipboard(String text) {}

    @Override
    public void onPasteTextFromClipboard() {}

    @Override
    public void onBell() {}

    @Override
    public void onColorsChanged() {}
}
