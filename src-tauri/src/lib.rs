mod desktop;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            app.manage(desktop::DesktopState::initialize(app.handle())?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Sesi & runtime
            desktop::commands::desktop_get_session,
            desktop::commands::desktop_get_runtime_status,
            desktop::commands::desktop_get_license_status,
            desktop::commands::desktop_install_license,
            desktop::commands::desktop_login,
            desktop::commands::desktop_logout,
            // Provisioning database
            desktop::commands::desktop_get_bootstrap_status,
            desktop::commands::desktop_bootstrap_superadmin,
            desktop::commands::desktop_check_bootstrap_database,
            desktop::commands::desktop_link_bootstrap_database,
            // Konfigurasi database
            desktop::commands::desktop_get_turso_url,
            desktop::commands::desktop_get_database_config,
            desktop::commands::desktop_save_turso_config,
            desktop::commands::desktop_test_turso_connection,
            desktop::commands::desktop_clear_turso_config,
            // Pemulihan password, konfigurasi email, dan verifikasi dua langkah
            desktop::commands::desktop_password_reset_approve,
            desktop::commands::desktop_password_reset_route,
            desktop::commands::desktop_password_recovery_with_code,
            desktop::commands::desktop_issue_recovery_codes,
            desktop::commands::desktop_list_password_reset_history,
            desktop::commands::desktop_get_password_reset_photo,
            desktop::commands::desktop_delete_password_reset_history,
            desktop::commands::desktop_purge_password_reset_history,
            desktop::commands::desktop_password_reset_lookup,
            desktop::commands::desktop_password_reset_confirm,
            desktop::commands::desktop_password_reset_swap_challenge,
            desktop::commands::desktop_password_reset_verify,
            desktop::commands::desktop_password_reset_inspect,
            desktop::commands::desktop_password_reset_complete,
            desktop::commands::desktop_send_test_mail,
            desktop::commands::desktop_get_mail_config,
            desktop::commands::desktop_save_mail_config,
            desktop::commands::desktop_get_two_factor_status,
            desktop::commands::desktop_begin_two_factor_setup,
            desktop::commands::desktop_confirm_two_factor_setup,
            desktop::commands::desktop_disable_two_factor,
            desktop::commands::desktop_admin_disable_two_factor,
            // Operator & RBAC
            desktop::commands::desktop_get_master_operators,
            desktop::commands::desktop_create_operator,
            desktop::commands::desktop_update_operator,
            desktop::commands::desktop_delete_operator,
            desktop::commands::desktop_get_roles,
            desktop::commands::desktop_create_role,
            desktop::commands::desktop_update_role,
            desktop::commands::desktop_set_role_permissions,
            desktop::commands::desktop_delete_role,
            // Sinkronisasi
            desktop::commands::desktop_sync_now,
            desktop::commands::desktop_get_sync_status,
            desktop::commands::desktop_get_sync_conflicts,
            desktop::commands::desktop_retry_failed_sync,
            desktop::commands::desktop_resolve_sync_conflicts,
            desktop::commands::desktop_resolve_sync_conflicts_local,
            desktop::commands::desktop_clear_failed_sync,
            desktop::commands::desktop_export_database,
            desktop::commands::desktop_import_database,
            desktop::commands::desktop_import_database_bytes,
            desktop::commands::desktop_get_data_folder,
            desktop::commands::desktop_get_company_profile,
            desktop::commands::desktop_update_company_profile,
            desktop::commands::desktop_get_server_url,
            desktop::commands::desktop_set_server_url,
            // Domain contoh — ganti dengan domain aplikasi Anda
            desktop::commands::desktop_list_clients,
            desktop::commands::desktop_register_client,
            desktop::commands::desktop_update_client,
            desktop::commands::desktop_list_master_options,
            desktop::commands::desktop_save_master_option,
            desktop::commands::desktop_get_client_code_settings,
            desktop::commands::desktop_save_client_code_settings,
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|error| {
            eprintln!("The desktop app stopped because the Tauri runtime failed: {error}");
            std::process::exit(1);
        });
}
