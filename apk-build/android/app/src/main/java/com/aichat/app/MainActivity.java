package com.aichat.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final int REQ_STORAGE = 1001;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 注册自定义沙箱插件
        registerPlugin(SandboxPlugin.class);
        super.onCreate(savedInstanceState);
        requestStoragePermissions();
        warnIfWebViewOutdated();
    }

    /**
     * 系统 WebView 由系统统一提供，App 无法指定内核实现；APK 内置 Chromium 会让包体
     * 增加 150MB 以上，且 Capacitor 的 JS 桥强绑 android.webkit.WebView，替换内核等于
     * 拆掉终端/文件/摄像头全部插件。这里做力所能及的两件事：检测内核版本并引导用户
     * 切换到 Chrome 实现，外部网页统一交给 Chrome 渲染。
     */
    private void warnIfWebViewOutdated() {
        if (Build.VERSION.SDK_INT < 26) return;
        try {
            android.content.pm.PackageInfo pi = android.webkit.WebView.getCurrentWebViewPackage();
            if (pi == null || pi.versionName == null) return;
            int major = Integer.parseInt(pi.versionName.split("\\.")[0]);
            if (major >= 120) return;
            new android.app.AlertDialog.Builder(this)
                .setTitle("内置网页内核版本偏低")
                .setMessage("当前 WebView：" + pi.packageName + " " + pi.versionName
                    + "\n\n外部网页已改为通过 Chrome 打开。若要让应用内页面也用新版内核，两条路："
                    + "\n\n① 更新 Android System WebView（点下面「去更新」）"
                    + "\n② 切换到 Chrome 内核：先开启开发者选项"
                    + "\n   设置 → 关于手机 → 连续点击「版本号」7 次，提示“您已处于开发者模式”"
                    + "\n   返回 → 系统 → 开发者选项 → 找到「WebView 实现」→ 选择 Chrome"
                    + "\n\n注：部分厂商 ROM 无「WebView 实现」入口，只能走第 ① 条。")
                .setPositiveButton("去更新", (d, w) -> {
                    try {
                        startActivity(new android.content.Intent(android.content.Intent.ACTION_VIEW,
                            android.net.Uri.parse("market://details?id=com.google.android.webview")));
                    } catch (Throwable ignored) {
                        try {
                            startActivity(new android.content.Intent(android.content.Intent.ACTION_VIEW,
                                android.net.Uri.parse("https://play.google.com/store/apps/details?id=com.google.android.webview")));
                        } catch (Throwable ignored2) {}
                    }
                })
                .setNegativeButton("知道了", null)
                .show();
        } catch (Throwable ignored) {}
    }

    private void requestStoragePermissions() {
        String[] perms;
        if (Build.VERSION.SDK_INT >= 33) {
            // Android 13+：分媒体类型
            perms = new String[]{
                Manifest.permission.READ_MEDIA_IMAGES,
                Manifest.permission.READ_MEDIA_VIDEO,
                Manifest.permission.READ_MEDIA_AUDIO,
                Manifest.permission.CAMERA
            };
        } else {
            // Android 12 及以下：通用存储
            perms = new String[]{
                Manifest.permission.READ_EXTERNAL_STORAGE,
                Manifest.permission.WRITE_EXTERNAL_STORAGE,
                Manifest.permission.CAMERA
            };
        }
        // 检查哪些还没授权
        java.util.List<String> need = new java.util.ArrayList<>();
        for (String p : perms) {
            if (ContextCompat.checkSelfPermission(this, p) != PackageManager.PERMISSION_GRANTED) {
                need.add(p);
            }
        }
        if (!need.isEmpty()) {
            ActivityCompat.requestPermissions(this, need.toArray(new String[0]), REQ_STORAGE);
        }
    }
}
