function resolveAppVersion({ isPackaged, electronVersion, packageVersion }) {
  return isPackaged ? electronVersion : packageVersion;
}

module.exports = { resolveAppVersion };
