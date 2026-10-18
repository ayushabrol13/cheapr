// Service workers have no DOMParser; this page parses fetched product HTML with the shared extractor.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.target !== "offscreen") return false;
  const doc = new DOMParser().parseFromString(msg.html, "text/html");
  reply(CheaprExtract.extractProduct(doc, msg.url));
  return false;
});
