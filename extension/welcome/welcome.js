const form = document.getElementById("setup");

chrome.storage.sync.get({ share: false, spend: false, email: "", onboarded: false }).then((s) => {
  if (s.onboarded) form.share.value = s.share ? "yes" : "no"; // first visit: no pre-selected answer
  form.spend.checked = s.spend;
  form.email.value = s.email;
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  await chrome.storage.sync.set({ onboarded: true, share: form.share.value === "yes", spend: form.spend.checked, email: form.email.value.trim() });
  document.getElementById("status").textContent = "All set. Open any product on Amazon.in or Flipkart to see Cheapr in action.";
});
