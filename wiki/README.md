# Playdarr wiki sources

This folder holds the pages of the Playdarr **Admin Guide**. They're written as a GitHub Wiki (file names are the page titles with hyphens, `Home.md` is the front page, `_Sidebar.md` is the navigation), but they live in the repo so they're versioned and reviewed with the code.

Start at [Home.md](Home.md).

## Publish to the GitHub Wiki tab

GitHub keeps a wiki in its own git repository, which only exists after the first page is created in the web UI.

1. In the GitHub repo: **Settings → Features → Wikis** (turn on), then open the **Wiki** tab and **Create the first page** (any content — it'll be overwritten).
2. Push these files into the wiki repository:

   ```bash
   git clone https://github.com/tf-anguskong/Playdarr.wiki.git
   cp wiki/*.md Playdarr.wiki/        # includes _Sidebar.md; skip this README if you like
   rm Playdarr.wiki/README.md         # optional: the wiki doesn't need it
   cd Playdarr.wiki
   git add -A && git commit -m "Update admin guide" && git push
   ```

3. Repeat step 2 whenever the pages change.

Links between pages use the wiki form (`[Text](Page-Name)`), so they work on the Wiki tab. When browsing the files inside the repo they won't click through — open the pages by file name instead.

## Keeping it accurate

When you change behaviour that these pages describe — admin controls, webhook events, scheduling rules, environment variables, data files — update the matching page in the same change. The pages most likely to need it:

| Change | Page |
|---|---|
| New or changed `.env` setting | [Configuration-Reference.md](Configuration-Reference.md) |
| Admin panel section or control | [Admin-Panel.md](Admin-Panel.md) |
| Webhook event or payload | [Webhooks-and-Notifications.md](Webhooks-and-Notifications.md) |
| Kick/close/nickname rules | [Moderation.md](Moderation.md) |
| Scheduling or recurrence rules | [Scheduling-and-Recurring-Nights.md](Scheduling-and-Recurring-Nights.md) |
| New file in the data folder | [Data-Backups-and-Updates.md](Data-Backups-and-Updates.md) |
