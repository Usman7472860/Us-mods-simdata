// Example command: .ping
module.exports = async ({ reply }) => {
  const start = Date.now();
  await reply(`🏓 Pong! ${Date.now() - start}ms`);
};
