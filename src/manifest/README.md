# Teams app package

`manifest.json`, `color.png` and `outline.png` are the real, filled-in values
for Dramantram's tenant - already uploaded and live in the org-wide setup
policy. The zip itself (`cbd-bot-teams-app.zip`) is a generated build
artifact, gitignored, not committed - rebuild it whenever any of the three
source files change:

```bash
cd src/manifest
rm -f cbd-bot-teams-app.zip
zip -j cbd-bot-teams-app.zip manifest.json color.png outline.png
```

The `-j` flag matters: it zips the files flat, with no enclosing folder.
Teams Admin Center rejects a package where the files sit inside a directory.

Re-upload under **Teams Admin Center > Teams apps > Manage apps > Upload new
app**, then it picks up automatically wherever the app is already assigned
(the Global setup policy, currently).

## If any of these values ever need to change

| Field | Current value | Comes from |
|---|---|---|
| `id`, `bots[0].botId`, `webApplicationInfo.id` | `ebc055ba-2fe4-41f7-b4f3-11bc26b1897b` | Azure AD app registration's Application (client) ID |
| `validDomains` | `cbd-bot.dramantram.com` | The domain in the server's `PUBLIC_BASE_URL` |
| `webApplicationInfo.resource` | `api://cbd-bot.dramantram.com/ebc055ba-2fe4-41f7-b4f3-11bc26b1897b` | Must exactly match the **Application ID URI** set on the app registration (Expose an API). A mismatch breaks Teams SSO silently with a consent loop. |

Icons are Dramantram's actual mask logo: `color.png` full-color at 192x192,
`outline.png` pure white on transparent at 32x32 (Teams rejects any other
color in the outline icon). Both were generated with Pillow from the source
artwork - see git history on this file if they ever need regenerating from a
different source image; the key detail is compositing the alpha channel
directly rather than via `Image.paste(img, box, mask)`, which blends partially
-transparent edge pixels toward black instead of preserving true color.
