const form = document.getElementById("setup");
const lang = document.getElementById("lang");

async function init() {
  await CheaprI18n.load();
  CheaprI18n.apply();
  const s = await chrome.storage.sync.get({ share: false, spend: false, email: "", onboarded: false, lang: "auto" });
  if (s.onboarded) form.share.value = s.share ? "yes" : "no"; // first visit: no pre-selected answer
  form.spend.checked = s.spend;
  form.email.value = s.email;
  lang.value = s.lang;
}

lang.addEventListener("change", async () => {
  await chrome.storage.sync.set({ lang: lang.value });
  init();
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  await chrome.storage.sync.set({ onboarded: true, share: form.share.value === "yes", spend: form.spend.checked, email: form.email.value.trim() });
  document.getElementById("status").textContent = CheaprI18n.t("w_done");
});

init();
