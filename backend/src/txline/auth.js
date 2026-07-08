// backend/src/txline/auth.js
// Handles TxLINE authentication.
// Call init() once at startup — returns { jwt, apiToken }
// Uses saved TXLINE_API_TOKEN from .env (set by subscribe.js)

const axios = require("axios");
const config = require("../../../shared/config");

let cachedAuth = null;

async function getJwt() {
  const res = await axios.post(`${config.txline.host}/auth/guest/start`);
  return res.data.token;
}

async function init() {
  const jwt = await getJwt();
  const apiToken = process.env.TXLINE_API_TOKEN;

  if (!apiToken) {
    throw new Error("TXLINE_API_TOKEN missing from .env — run scripts/subscribe.js first");
  }

  cachedAuth = { jwt, apiToken };
  console.log("[auth] Initialized — JWT + API token ready");
  return cachedAuth;
}

function getAuth() {
  if (!cachedAuth) throw new Error("auth.init() not called yet");
  return cachedAuth;
}

function makeHeaders() {
  const { jwt, apiToken } = getAuth();
  return {
    "Authorization": `Bearer ${jwt}`,
    "X-Api-Token": apiToken,
    "Content-Type": "application/json",
  };
}

module.exports = { init, getAuth, makeHeaders };
