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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|_app, _args, _cwd| {}))
        .plugin(tauri_plugin_opener::init())
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
            let pair = MenuItem::with_id(app, "pair", "Afficher le QR de pairing", true, None::<&str>)?;
            let dash = MenuItem::with_id(app, "dash", "Ouvrir le tableau de bord", true, None::<&str>)?;
            let logs = MenuItem::with_id(app, "logs", "Ouvrir le dossier de données", true, None::<&str>)?;
            let auto = CheckMenuItem::with_id(app, "auto", "Démarrer avec Windows", true, app.autolaunch().is_enabled().unwrap_or(false), None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quitter", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&pair, &dash, &logs, &PredefinedMenuItem::separator(app)?, &auto, &PredefinedMenuItem::separator(app)?, &quit])?;

            let data = dir.clone();
            let svc_quit = svc.clone();
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Couch Stream App")
                .menu(&menu)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "pair" => open_url(app, &format!("http://127.0.0.1:{port}/pair")),
                    "dash" => open_url(app, &format!("http://127.0.0.1:{port}/")),
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
