// Example command: .menu
module.exports = async ({ reply, config, isOwner }) => {
  const txt = `╔═══════════════════╗
║   *US MOD MD V2*   ║
╚═══════════════════╝

👑 Owner: ${config.ownerName}
🔰 Prefix: \`${config.prefix}\`

📋 *Available Commands:*
• ${config.prefix}menu — Ye menu
• ${config.prefix}ping — Bot check

_More commands coming soon..._`;

  await reply(txt);
};
