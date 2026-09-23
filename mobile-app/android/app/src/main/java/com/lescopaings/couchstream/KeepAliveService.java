package com.lescopaings.couchstream;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

/**
 * Service de premier plan minimal : sa seule raison d'être est d'empêcher
 * Android de mettre le process en veille (Doze / App Standby) pendant que
 * le micro est envoyé ou que le chat doit rester réactif écran éteint /
 * app en arrière-plan. Tout le travail réel (WebSocket, WebRTC, mic) reste
 * dans la WebView Capacitor, qui tourne dans le même process — ce service
 * ne fait rien d'autre que le maintenir vivant.
 */
public class KeepAliveService extends Service {

  private static final String CHANNEL_ID = "couch_stream_keep_alive";
  private static final int NOTIFICATION_ID = 4242;

  private PowerManager.WakeLock wakeLock;

  @Override
  public void onCreate() {
    super.onCreate();
    createChannelIfNeeded();
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    startForeground(NOTIFICATION_ID, buildNotification(), foregroundServiceType());
    acquireWakeLock();
    // START_STICKY : si Android tue quand même le process (mémoire très
    // basse), il retente de relancer le service — sans garantie stricte,
    // mais c'est le comportement le plus proche de "reste actif" possible.
    return START_STICKY;
  }

  @Override
  public void onDestroy() {
    releaseWakeLock();
    super.onDestroy();
  }

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }

  // Android 14+ (API 34) exige que RECORD_AUDIO soit déjà accordée AVANT
  // d'appeler startForeground avec le type "microphone", sous peine de
  // SecurityException — ce service démarre à la connexion WS, souvent avant
  // que l'utilisateur n'ait jamais ouvert l'onglet Micro (donc avant tout
  // prompt getUserMedia). On ne déclare "microphone" que si la permission
  // est déjà accordée ; www/app.js relance start() juste après un
  // getUserMedia réussi pour promouvoir le service à ce moment-là.
  private int foregroundServiceType() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return 0;
    int type = android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC;
    boolean micGranted = androidx.core.content.ContextCompat.checkSelfPermission(
      this, android.Manifest.permission.RECORD_AUDIO
    ) == android.content.pm.PackageManager.PERMISSION_GRANTED;
    if (micGranted) type |= android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
    return type;
  }

  private void acquireWakeLock() {
    if (wakeLock != null && wakeLock.isHeld()) return;
    PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "CouchStreamApp:keepAlive");
    wakeLock.setReferenceCounted(false);
    wakeLock.acquire();
  }

  private void releaseWakeLock() {
    if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
    wakeLock = null;
  }

  private void createChannelIfNeeded() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
    NotificationManager nm = getSystemService(NotificationManager.class);
    if (nm.getNotificationChannel(CHANNEL_ID) != null) return;
    NotificationChannel channel = new NotificationChannel(
      CHANNEL_ID, "Couch Stream App actif", NotificationManager.IMPORTANCE_LOW
    );
    channel.setDescription("Notification persistante pendant que le micro ou le chat sont actifs en arrière-plan.");
    channel.setShowBadge(false);
    nm.createNotificationChannel(channel);
  }

  private Notification buildNotification() {
    Intent launchIntent = getPackageManager().getLaunchIntentForPackage(getPackageName());
    PendingIntent contentIntent = PendingIntent.getActivity(
      this, 0, launchIntent,
      PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
    );

    Notification.Builder builder = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
      ? new Notification.Builder(this, CHANNEL_ID)
      : new Notification.Builder(this);

    return builder
      .setContentTitle("Couch Stream App")
      .setContentText("Connecté — micro/chat actifs en arrière-plan")
      .setSmallIcon(R.drawable.ic_launcher_foreground)
      .setContentIntent(contentIntent)
      .setOngoing(true)
      .build();
  }
}
