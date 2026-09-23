# Teams app package

Zip these three files (flat, no folder) and upload under Teams Admin Center >
Teams apps > Manage apps > Upload new app:

    manifest.json  color.png  outline.png

Before zipping, replace every `TODO_` value in `manifest.json`:

| Placeholder | Where it comes from |
|---|---|
| `TODO_AZURE_AD_APP_ID` | Azure AD app registration > Application (client) ID. Same value in all three places. |
| `TODO_your-public-domain.com` | The domain in `PUBLIC_BASE_URL`, without the scheme. |

`webApplicationInfo.resource` must exactly match the Application ID URI set on
the app registration (Expose an API > Application ID URI), or Teams SSO fails
silently with a consent loop.

Icons: `color.png` is 192x192, `outline.png` is 32x32, transparent, white-on-
transparent glyph only. TODO: drop in the real Dramantram mark; the checked-in
files are plain placeholders.
