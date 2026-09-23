package com.lescopaings.couchstream;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Pont JS <-> KeepAliveService, plus la création du canal de notification
 * "alarme" (voir ensureAlarmChannel) — deux responsabilités distinctes mais
 * qui partagent le même besoin d'accès natif Android, pas de raison de
 * multiplier les plugins pour un projet de cette taille.
 */
@CapacitorPlugin(name = "KeepAlive")
public class KeepAlivePlugin extends Plugin {

  // Champ AudioAttributes.USAGE_ALARM + setBypassDnd(true) : aucun des deux
  // n'est exposé par l'API JS de @capacitor/local-notifications
  // (Channel.sound ne prend qu'un nom de fichier, pas des AudioAttributes),
  // d'où ce canal créé nativement plutôt que via LocalNotifications.createChannel.
  // Nouvel id obligatoire : un canal Android existant est immuable une fois
  // créé (seul l'utilisateur peut le modifier depuis les réglages système).
  public static final String ALARM_CHANNEL_ID = "chat-alerts-alarm";

  @PluginMethod
  public void start(PluginCall call) {
    Intent intent = new Intent(getContext(), KeepAliveService.class);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      getContext().startForegroundService(intent);
    } else {
      getContext().startService(intent);
    }
    call.resolve();
  }

  @PluginMethod
  public void stop(PluginCall call) {
    getContext().stopService(new Intent(getContext(), KeepAliveService.class));
    call.resolve();
  }

  @PluginMethod
  public void ensureAlarmChannel(PluginCall call) {
    ensureAlarmChannelInternal();
    call.resolve();
  }

  private void ensureAlarmChannelInternal() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
    NotificationManager nm = getContext().getSystemService(NotificationManager.class);
    if (nm.getNotificationChannel(ALARM_CHANNEL_ID) != null) return;
    NotificationChannel channel = new NotificationChannel(
      ALARM_CHANNEL_ID, "Alertes chat (prioritaires)", NotificationManager.IMPORTANCE_HIGH
    );
    channel.setDescription(
      "Nouveau message ou mention pendant le live — sonne/vibre même en mode silencieux ou Ne pas déranger"
    );
    // Ne fait réellement quelque chose que si l'utilisateur a accordé
    // l'accès "Ne pas déranger" à l'app (réglages système, pas une
    // permission runtime classique) — sinon ce flag est ignoré sans erreur.
    channel.setBypassDnd(true);
    channel.enableVibration(true);
    channel.setVibrationPattern(new long[] { 0, 400, 200, 400 });
    channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);

    AudioAttributes audioAttributes = new AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_ALARM)
      .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
      .build();
    Uri soundUri = RingtoneManager.getActualDefaultRingtoneUri(getContext(), RingtoneManager.TYPE_ALARM);
    if (soundUri == null) soundUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
    channel.setSound(soundUri, audioAttributes);

    nm.createNotificationChannel(channel);
  }

  // Poste la notification nous-mêmes plutôt que via LocalNotifications.schedule() :
  // ce dernier appelle toujours Builder.setSound(...) avec un son par défaut,
  // ce qui sur cet appareil prend le pas sur les AudioAttributes/USAGE_ALARM du
  // canal (constaté en test réel : le son effectif restait USAGE_NOTIFICATION
  // malgré un canal correctement configuré en USAGE_ALARM). En ne posant jamais
  // de son/vibration au niveau de la notification, seul le canal gouverne —
  // comportement Android 8+ correct.
  @PluginMethod
  public void postAlert(PluginCall call) {
    Integer id = call.getInt("id");
    if (id == null) {
      call.reject("id manquant");
      return;
    }
    String title = call.getString("title", "");
    String body = call.getString("body", "");

    ensureAlarmChannelInternal();

    Intent launchIntent = getContext().getPackageManager().getLaunchIntentForPackage(getContext().getPackageName());
    int flags = PendingIntent.FLAG_UPDATE_CURRENT;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
    PendingIntent contentIntent = PendingIntent.getActivity(getContext(), id, launchIntent, flags);

    NotificationCompat.Builder builder = new NotificationCompat.Builder(getContext(), ALARM_CHANNEL_ID)
      .setContentTitle(title)
      .setContentText(body)
      .setSmallIcon(R.drawable.ic_launcher_foreground)
      .setAutoCancel(true)
      .setContentIntent(contentIntent)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setCategory(NotificationCompat.CATEGORY_MESSAGE);

    if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
      NotificationManagerCompat.from(getContext()).notify(id, builder.build());
    }
    call.resolve();
  }
}
