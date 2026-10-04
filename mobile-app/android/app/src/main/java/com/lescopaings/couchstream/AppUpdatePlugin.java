package com.lescopaings.couchstream;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Mise à jour de l'app depuis le PC : télécharge l'APK servi par le service
 * compagnon (/app.apk, LAN) puis lance l'installeur système. L'APK est signé
 * avec la même clé que la version installée : Android l'installe par-dessus,
 * sans perdre les réglages. Android impose toujours sa propre confirmation et,
 * la première fois, l'autorisation « installer des applis inconnues » pour
 * cette app (REQUEST_INSTALL_PACKAGES) — d'où la méthode openInstallSettings.
 */
@CapacitorPlugin(name = "AppUpdate")
public class AppUpdatePlugin extends Plugin {

  private static final String APK_NAME = "CouchStream.apk";

  private File apkFile() {
    File dir = new File(getContext().getCacheDir(), "updates");
    if (!dir.exists()) dir.mkdirs();
    return new File(dir, APK_NAME);
  }

  private boolean canInstall() {
    return Build.VERSION.SDK_INT < Build.VERSION_CODES.O || getContext().getPackageManager().canRequestPackageInstalls();
  }

  /** Télécharge puis installe ; renvoie {needsPermission:true} si l'autorisation manque. */
  @PluginMethod
  public void downloadAndInstall(PluginCall call) {
    String url = call.getString("url");
    if (url == null || url.isEmpty()) {
      call.reject("url manquante");
      return;
    }
    new Thread(() -> {
      File target = apkFile();
      File tmp = new File(target.getParentFile(), APK_NAME + ".part");
      HttpURLConnection conn = null;
      try {
        conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(8000);
        conn.setReadTimeout(15000);
        if (conn.getResponseCode() != 200) {
          call.reject("le PC n'a pas pu fournir l'APK (HTTP " + conn.getResponseCode() + ")");
          return;
        }
        long total = conn.getContentLengthLong();
        long done = 0;
        int lastPercent = -1;
        try (InputStream in = conn.getInputStream(); FileOutputStream out = new FileOutputStream(tmp)) {
          byte[] buf = new byte[64 * 1024];
          int n;
          while ((n = in.read(buf)) > 0) {
            out.write(buf, 0, n);
            done += n;
            if (total > 0) {
              int percent = (int) (done * 100 / total);
              if (percent != lastPercent) {
                lastPercent = percent;
                JSObject p = new JSObject();
                p.put("percent", percent);
                notifyListeners("progress", p);
              }
            }
          }
        }
        if (total > 0 && done != total) {
          call.reject("téléchargement incomplet");
          return;
        }
        if (target.exists()) target.delete();
        if (!tmp.renameTo(target)) {
          call.reject("impossible d'enregistrer l'APK");
          return;
        }
        launchInstall(call);
      } catch (Exception e) {
        call.reject("téléchargement impossible : " + e.getMessage());
      } finally {
        if (conn != null) conn.disconnect();
        if (tmp.exists()) tmp.delete();
      }
    }).start();
  }

  /** Relance l'installation de l'APK déjà téléchargé (après l'écran d'autorisation). */
  @PluginMethod
  public void install(PluginCall call) {
    if (!apkFile().exists()) {
      call.reject("aucun APK téléchargé");
      return;
    }
    launchInstall(call);
  }

  @PluginMethod
  public void openInstallSettings(PluginCall call) {
    Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    getContext().startActivity(intent);
    call.resolve();
  }

  private void launchInstall(PluginCall call) {
    JSObject result = new JSObject();
    if (!canInstall()) {
      result.put("needsPermission", true);
      call.resolve(result);
      return;
    }
    Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apkFile());
    Intent intent = new Intent(Intent.ACTION_VIEW);
    intent.setDataAndType(uri, "application/vnd.android.package-archive");
    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
    getContext().startActivity(intent);
    result.put("needsPermission", false);
    call.resolve(result);
  }
}
