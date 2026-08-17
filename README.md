# UAH Academy — Lesson 1 Feedback (deployable prototype)

This is the same Beginner-tier feedback tool you've been testing, restructured so it can run on a real server instead of only inside a Claude preview. The API key now lives safely on the server — never in the browser.

## What you need before starting

1. **An Anthropic API key** — go to https://console.anthropic.com, create an account, add a payment method, then go to "API Keys" and create a new key. Copy it somewhere safe; you'll paste it into Render in step 3 below.
2. **A GitHub account** — https://github.com — free, no coding required for this step, just somewhere to hold the code files so Render can find them.
3. **A Render account** — https://render.com — free to sign up.

## Step 1: Get the code onto GitHub

1. Log into GitHub, click the **+** in the top right, choose **New repository**.
2. Name it something like `uah-academy` and click **Create repository**.
3. On the new repo's page, click **"uploading an existing file"** (or Add file → Upload files).
4. Drag in every file from this folder — `server.js`, `package.json`, `.gitignore`, and the whole `public` folder (including `index.html` inside it).
5. Scroll down, click **Commit changes**.

No command line needed for any of this — it's all drag-and-drop in the browser.

## Step 2: Create the Render web service

1. Log into Render, click **New +** → **Web Service**.
2. Connect your GitHub account if prompted, then select the `uah-academy` repository you just created.
3. Render should auto-detect it as a Node app. If asked:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
4. Choose the free plan to start.

## Step 3: Add your API key (important — do this before deploying, or right after)

1. On your new service's page in Render, go to the **Environment** tab.
2. Add a new environment variable:
   - **Key:** `ANTHROPIC_API_KEY`
   - **Value:** (paste the key you copied from Anthropic's console)
3. Save. Render will redeploy automatically.

## Step 4: Test it

Render gives you a URL like `uah-academy.onrender.com`. Open it — you should see the same feedback tool you've been testing, now live on the internet. Try it with a real photo before doing anything else.

## Step 5: Point your subdomain at it

1. In Render, go to your service's **Settings** → **Custom Domains**, and add `academy.ulverstonarthouse.co.uk`.
2. Render will show you a value to add as a **CNAME record** in your DNS (Cloudflare, since that's where your domain's DNS lives).
3. In Cloudflare's DNS tab, add that CNAME record exactly as Render shows it.
4. Wait a few minutes, then check the custom domain again in Render — it should show as verified with automatic HTTPS.

## If something doesn't work

Render shows live logs under the **Logs** tab for your service — if a request fails, the error message will usually show up there. Copy whatever it says and we can work out what it means together.
