/**
 * DriveLens runtime base constants (NEVER put any API Key, OAuth Client ID, or private folder credentials here).
 * Enter connection credentials in the web "Connect Drive" modal; they stay strictly in browser localStorage.
 */
export const APP_CONFIG = {
  DEFAULT_API_KEY: '',
  DEFAULT_CLIENT_ID: '',
  DEFAULT_FOLDER_ID: '',
  APP_TITLE: 'DriveLens · Shared Drive Photo Gallery',
  THUMBNAIL_CONCURRENCY: 12,
  DRIVE_LIST_PAGE_SIZE: 1000,
  DRIVE_MAX_RETRIES: 4,
  DRIVE_MAX_BACKOFF_MS: 32000,
  SYNC_DEBOUNCE_MS: 800,
};
