# US MOD MD V2 — Vercel Deployment

## Vercel Pe Deploy Kaise Karein

### Method 1: GitHub se (Recommended)

1. Ye files GitHub pe upload karo (new repository banao)
2. [vercel.com](https://vercel.com) pe jao → Login karo
3. "New Project" → GitHub repo select karo
4. Deploy karo — bas!

### Method 2: Vercel CLI se

```bash
npm install -g vercel
cd us-mod-md-v2
vercel login
vercel --prod
```

## ⚠️ Zaroori Note

Vercel **serverless** platform hai. Iska matlab:
- Sessions `/tmp` mein save hoti hain (temporary)
- Agar Vercel function cold restart kare, sessions reset ho sakti hain
- **Permanent sessions ke liye Railway / Render / Koyeb zyada better hai**

## Config

`config.js` file mein apna number aur settings update karo:
```js
ownerNumber: "923161407016",  // Apna number
prefix: ".",                   // Command prefix
selfReply: false,
```

## Commands Folder

`commands/` folder mein apni command files daalo.
Har file ka naam command ka naam hoga. Example:
- `commands/menu.js` → `.menu` command

## Web UI

Deploy ke baad URL pe jao:
- `https://your-app.vercel.app` → Session Manager UI
- Phone number daalo → Connect → Pairing code aayega
