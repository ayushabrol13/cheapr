// Service workers have no DOMParser; this page parses fetched product HTML with the shared extractor.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.target !== "offscreen") return false;
  const doc = new DOMParser().parseFromString(msg.html, "text/html");
  if (msg.kind === "search") reply(CheaprCompare.bestMatch(msg.product, CheaprCompare.parseSearch(msg.store, doc).filter((c) => !msg.reject?.includes(c.product_id))));
  else reply(CheaprExtract.extractProduct(doc, msg.url));
  return false;
});
