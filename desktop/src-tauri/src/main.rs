#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{self, File, OpenOptions};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const RESTART_DELAY: Duration = Duration::from_secs(5);
const LOG_MAX_BYTES: u64 = 1_000_000;

struct Service {
    child: Mutex<Option<Child>>,
    quitting: AtomicBool,
}

// Chemins Windows renvoyés par Tauri préfixés `\\?\` : Node les refuse comme
// cwd/script (EISDIR lstat 'C:'), voir desktop/README.md.
fn plain(p: PathBuf) -> PathBuf {
    PathBuf::from(p.to_string_lossy().trim_start_matches("\\\\?\\"))
}

fn data_dir() -> PathBuf {
    let base = std::env::var("APPDATA").map(PathBuf::from).unwrap_or_else(|_| std::env::temp_dir());
    base.join("CouchStreamApp")
}

// Port lu dans le .env du dossier de données (LOCAL_WS_PORT), 8765 par défaut.
fn local_port(dir: &Path) -> u16 {
    fs::read_to_string(dir.join(".env"))
        .ok()
        .and_then(|s| {
            s.lines()
                .find_map(|l| l.strip_prefix("LOCAL_WS_PORT="))
                .and_then(|v| v.trim().parse().ok())
        })
        .unwrap_or(8765)
}

fn open_log(dir: &Path) -> File {
    let path = dir.join("service.log");
    if fs::metadata(&path).map(|m| m.len() > LOG_MAX_BYTES).unwrap_or(false) {
        let _ = fs::rename(&path, dir.join("service.old.log"));
    }
    OpenOptions::new().create(true).append(true).open(path).expect("service.log")
}

fn spawn_service(app: &AppHandle, dir: &Path) -> std::io::Result<Child> {
    let exe_dir = std::env::current_exe()?.parent().unwrap().to_path_buf();
    let sidecar = plain(app.path().resource_dir().map_err(std::io::Error::other)?.join("sidecar").join("pc-service"));
    let log = open_log(dir);
    Command::new(exe_dir.join("node.exe"))
        .arg("src/index.js")
        .current_dir(&sidecar)
        .env("COUCH_DATA_DIR", dir)
        .env("COUCH_PARENT_STDIN", "1")
        .stdin(Stdio::piped())
        .stdout(log.try_clone()?)
        .stderr(log)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
}

// Relance le service s'il s'arrête (crash, OBS pas prêt au démarrage...).
fn supervise(app: AppHandle, svc: Arc<Service>, dir: PathBuf) {
    thread::spawn(move || {
        while !svc.quitting.load(Ordering::SeqCst) {
            match spawn_service(&app, &dir) {
                Ok(child) => *svc.child.lock().unwrap() = Some(child),
                Err(e) => {
                    let _ = fs::write(dir.join("spawn-error.txt"), e.to_string());
                }
            }
            loop {
                thread::sleep(Duration::from_millis(500));
                if svc.quitting.load(Ordering::SeqCst) {
                    return;
                }
                let mut guard = svc.child.lock().unwrap();
                match guard.as_mut().map(|c| c.try_wait()) {
                    Some(Ok(None)) => continue,
                    _ => {
                        *guard = None;
                        break;
                    }
                }
            }
            thread::sleep(RESTART_DELAY);
        }
    });
}

fn open_url(app: &AppHandle, url: &str) {
    let _ = app.opener().open_url(url, None::<&str>);
}

// Ouvre une page du service ; s'il ne répond pas encore (démarrage de
// Windows, redémarrage après crash), ouvre à la place une page d'attente qui
// l'explique et bascule seule vers la vraie page dès que le service répond —
// au lieu d'une page blanche « connexion refusée ».
fn open_service_page(app: &AppHandle, dir: &Path, _port: u16, path: &str) {
    // Le service peut avoir changé de port (port occupé) : on relit le .env à chaque ouverture.
    let port = local_port(dir);
    let url = format!("http://127.0.0.1:{port}{path}");
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    if std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(400)).is_ok() {
        return open_url(app, &url);
    }
    let html = format!(
        r#"<!doctype html><meta charset="utf-8"><title>Couch Stream App</title>
<body style="font-family:system-ui,sans-serif;background:#0d0d10;color:#eee;max-width:32rem;margin:4rem auto;padding:0 1rem">
<h2>Le service démarre…</h2>
<p style="color:#9a9aa2;line-height:1.5">Le service Couch Stream n'est pas encore prêt (démarrage de Windows ou redémarrage automatique). Cette page s'ouvrira toute seule dès qu'il répond.</p>
<p style="color:#9a9aa2;line-height:1.5">Si ça dure, ouvre le dossier de données depuis l'icône de la zone de notification et consulte <b>service.log</b>.</p>
<script>const u="{url}";setInterval(()=>fetch(u,{{mode:"no-cors"}}).then(()=>location.replace(u)).catch(()=>{{}}),1500)</script>"#
    );
    let page = dir.join("starting.html");
    if fs::write(&page, html).is_ok() {
        open_url(app, &page.to_string_lossy());
    }
}

// Vérifie (et installe) une mise à jour signée. Au démarrage : silencieux. À la
// demande (menu) : le résultat s'affiche dans une petite page, sinon un clic
// sur « Rechercher une mise à jour » ne donnerait aucun retour.
fn check_update(app: AppHandle, dir: PathBuf, manual: bool) {
    tauri::async_runtime::spawn(async move {
        let current = app.package_info().version.to_string();
        let message = match app.updater() {
            Ok(updater) => match updater.check().await {
                Ok(Some(update)) => {
                    let version = update.version.clone();
                    // L'installeur ferme l'app puis la relance ; le service Node s'arrête avec elle.
                    match update.download_and_install(|_, _| {}, || {}).await {
                        Ok(_) => format!("La version {version} est installée. L'application redémarre."),
                        Err(e) => format!("La version {version} est disponible mais l'installation a échoué : {e}"),
                    }
                }
                Ok(None) => format!("Tu utilises la dernière version ({current})."),
                Err(e) => format!("Vérification impossible pour le moment : {e}"),
            },
            Err(e) => format!("Mises à jour indisponibles : {e}"),
        };
        let _ = fs::write(dir.join("updater.log"), format!("{message}\n"));
        if manual {
            let page = dir.join("update.html");
            let html = format!(
                "<!doctype html><meta charset=\"utf-8\"><title>Mise à jour</title><body style=\"font-family:system-ui,sans-serif;background:#0d0d10;color:#eee;max-width:32rem;margin:4rem auto;padding:0 1rem\"><h2>Mise à jour</h2><p style=\"color:#9a9aa2;line-height:1.5\">{message}</p>"
            );
            if fs::write(&page, html).is_ok() {
                open_url(&app, &page.to_string_lossy());
            }
        }
    });
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|_app, _args, _cwd| {}))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None::<Vec<&'static str>>))
        .setup(|app| {
            let dir = data_dir();
            fs::create_dir_all(&dir)?;

            // Premier lancement : démarrage automatique avec Windows activé par défaut.
            let marker = dir.join(".autostart-initialised");
            if !marker.exists() {
                let _ = app.autolaunch().enable();
                let _ = fs::write(&marker, "");
            }

            let svc = Arc::new(Service { child: Mutex::new(None), quitting: AtomicBool::new(false) });
            supervise(app.handle().clone(), svc.clone(), dir.clone());

            let port = local_port(&dir);

            // Vérification automatique 60 s après le démarrage, puis toutes les 6 h :
            // l'app tourne des jours entiers (démarrage avec Windows), et un réseau
            // absent au démarrage ne doit pas la priver de mises à jour (jamais bloquant).
            {
                let handle = app.handle().clone();
                let dir = dir.clone();
                thread::spawn(move || {
                    thread::sleep(Duration::from_secs(60));
                    loop {
                        check_update(handle.clone(), dir.clone(), false);
                        thread::sleep(Duration::from_secs(6 * 3600));
                    }
                });
            }

            // Premier lancement (pas d'assistant terminé) : ouvre l'assistant dès
            // que le service répond, au lieu de laisser une icône muette.
            {
                let handle = app.handle().clone();
                let dir = dir.clone();
                thread::spawn(move || {
                    for _ in 0..120 {
                        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], local_port(&dir)));
                        if std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(400)).is_ok() {
                            thread::sleep(Duration::from_secs(2)); // laisse le service écrire setup.json s'il migre une ancienne config
                            // Assistant absent ou inachevé (le dossier de données survit à une désinstallation).
                            let done = fs::read_to_string(dir.join("setup.json"))
                                .map(|s| s.replace(' ', "").contains("\"completed\":true"))
                                .unwrap_or(false);
                            if !done {
                                open_service_page(&handle, &dir, port, "/setup");
                            }
                            return;
                        }
                        thread::sleep(Duration::from_millis(500));
                    }
                });
            }
            let state = MenuItem::with_id(app, "state", "Ouvrir la console", true, None::<&str>)?;
            let setup_item = MenuItem::with_id(app, "setup", "Assistant de configuration", true, None::<&str>)?;
            let update_item = MenuItem::with_id(app, "update", "Rechercher une mise à jour", true, None::<&str>)?;
            let pair = MenuItem::with_id(app, "pair", "Jumeler un téléphone (QR)", true, None::<&str>)?;
            let logs = MenuItem::with_id(app, "logs", "Ouvrir le dossier de données", true, None::<&str>)?;
            let auto = CheckMenuItem::with_id(app, "auto", "Démarrer avec Windows", true, app.autolaunch().is_enabled().unwrap_or(false), None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quitter", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&state, &pair, &setup_item, &update_item, &logs, &PredefinedMenuItem::separator(app)?, &auto, &PredefinedMenuItem::separator(app)?, &quit])?;

            let data = dir.clone();
            let svc_quit = svc.clone();
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Couch Stream App")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event({
                    let data = dir.clone();
                    move |tray, event| {
                        if let tauri::tray::TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, button_state: tauri::tray::MouseButtonState::Up, .. } = event {
                            open_service_page(tray.app_handle(), &data, port, "/desktop");
                        }
                    }
                })
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "state" => open_service_page(app, &data, port, "/desktop"),
                    "update" => check_update(app.clone(), data.clone(), true),
                    "setup" => open_service_page(app, &data, port, "/setup"),
                    "pair" => open_service_page(app, &data, port, "/desktop#pair"),
                    "logs" => open_url(app, &data.to_string_lossy()),
                    "auto" => {
                        let al = app.autolaunch();
                        if al.is_enabled().unwrap_or(false) { let _ = al.disable(); } else { let _ = al.enable(); }
                        let _ = auto.set_checked(al.is_enabled().unwrap_or(false));
                    }
                    "quit" => {
                        svc_quit.quitting.store(true, Ordering::SeqCst);
                        if let Some(mut c) = svc_quit.child.lock().unwrap().take() {
                            let _ = c.kill();
                        }
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("erreur tauri");
}
