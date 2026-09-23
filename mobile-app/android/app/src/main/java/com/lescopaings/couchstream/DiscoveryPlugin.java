package com.lescopaings.couchstream;

import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Handler;
import android.os.Looper;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.net.Inet4Address;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.LinkedList;
import java.util.Map;
import java.util.Queue;
import java.util.Set;

/**
 * Découverte mDNS/DNS-SD du PC (`_couchstream._tcp`, annoncé par le service
 * PC — voir pc-service/src/discovery.js). Une WebView ne sait pas faire du
 * multicast DNS : sans ce plugin, l'app ne pourrait retrouver le PC qu'en
 * balayant le sous-réseau connu.
 */
@CapacitorPlugin(name = "Discovery")
public class DiscoveryPlugin extends Plugin {

  private static final String SERVICE_TYPE = "_couchstream._tcp.";

  @PluginMethod
  public void find(PluginCall call) {
    final int timeoutMs = call.getInt("timeoutMs", 4000);
    final Context ctx = getContext();
    final NsdManager nsd = (NsdManager) ctx.getSystemService(Context.NSD_SERVICE);
    final WifiManager wifi = (WifiManager) ctx.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
    final WifiManager.MulticastLock lock = wifi.createMulticastLock("couchstream-nsd");
    lock.setReferenceCounted(false);
    lock.acquire();

    final JSArray services = new JSArray();
    final Set<String> seen = new HashSet<>();
    final Queue<NsdServiceInfo> toResolve = new LinkedList<>();
    final boolean[] resolving = {false};
    final boolean[] done = {false};
    final Handler main = new Handler(Looper.getMainLooper());

    // NsdManager n'autorise qu'une résolution à la fois : on les enchaîne.
    final Runnable[] resolveNext = new Runnable[1];
    resolveNext[0] = () -> {
      if (done[0] || resolving[0]) return;
      final NsdServiceInfo next = toResolve.poll();
      if (next == null) return;
      resolving[0] = true;
      nsd.resolveService(next, new NsdManager.ResolveListener() {
        @Override public void onResolveFailed(NsdServiceInfo info, int errorCode) {
          resolving[0] = false;
          main.post(resolveNext[0]);
        }
        @Override public void onServiceResolved(NsdServiceInfo info) {
          resolving[0] = false;
          if (!done[0] && info.getHost() instanceof Inet4Address) {
            JSObject svc = new JSObject();
            svc.put("host", info.getHost().getHostAddress());
            svc.put("port", info.getPort());
            svc.put("id", txt(info, "id"));
            svc.put("name", txt(info, "name"));
            services.put(svc);
          }
          main.post(resolveNext[0]);
        }
      });
    };

    final NsdManager.DiscoveryListener listener = new NsdManager.DiscoveryListener() {
      @Override public void onDiscoveryStarted(String type) {}
      @Override public void onDiscoveryStopped(String type) {}
      @Override public void onStartDiscoveryFailed(String type, int code) {}
      @Override public void onStopDiscoveryFailed(String type, int code) {}
      @Override public void onServiceLost(NsdServiceInfo info) {}
      @Override public void onServiceFound(NsdServiceInfo info) {
        if (seen.add(info.getServiceName())) {
          toResolve.add(info);
          main.post(resolveNext[0]);
        }
      }
    };

    try {
      nsd.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener);
    } catch (Exception e) {
      lock.release();
      call.reject("découverte impossible: " + e.getMessage());
      return;
    }

    main.postDelayed(() -> {
      done[0] = true;
      try { nsd.stopServiceDiscovery(listener); } catch (Exception ignored) {}
      if (lock.isHeld()) lock.release();
      JSObject result = new JSObject();
      result.put("services", services);
      call.resolve(result);
    }, timeoutMs);
  }

  private static String txt(NsdServiceInfo info, String key) {
    Map<String, byte[]> attrs = info.getAttributes();
    byte[] v = attrs == null ? null : attrs.get(key);
    return v == null ? "" : new String(v, StandardCharsets.UTF_8);
  }
}
