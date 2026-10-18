// UI strings in English and Hindi. Classic script (content scripts, popup, welcome, service worker): CheaprI18n.
// Language: the "lang" setting (auto | en | hi); auto follows the browser. Missing Hindi keys fall back to English.
(() => {
  const en = {
    // verdicts
    v_buy: "Lowest price ever", v_good: "Good deal", v_fair: "Fair price", v_wait: "Usually cheaper", v_new: "Tracking started",
    offline: "Offline", checking: "Checking…", no_history: "No history yet",
    // insights
    i_all_time_low: "Lowest price we've ever recorded.",
    i_window_low: "Lowest price in the last {days} days.",
    i_drop: "Dropped {pct}% from {from} on {date}.",
    i_rise: "Up {pct}% from {from} on {date}.",
    i_inflated_sale: "Heads up: price was raised to {peak} recently. Today's \"deal\" is about the usual {usual}.",
    i_inflated_mrp: "MRP looks inflated: we've never seen it above {highest}. Real discount vs usual price: {pct}%.",
    // card
    low_3m: "3M low", usual: "Usual", set_alert: "Set alert", alert_at: "Alert at {price}", show_history: "Show price history",
    collapse: "Collapse", options: "Cheapr options", hide_on: "Hide on {site}", pause_all: "Pause Cheapr on all sites",
    settings: "Settings", lowest: "Lowest", usual_price: "Usual price", highest: "Highest",
    checks_since: "{n} price checks since {date}", check_since: "1 price check since {date}",
    need_week: "We need about a week of prices before judging a deal. Set an alert and we'll watch it for you.",
    started_today: "Cheapr started tracking this product today. We'll show a price trend once the price changes, and a verdict after about a week.",
    started_on: "Cheapr started tracking this product on {date}. We'll show a price trend once the price changes, and a verdict after about a week.",
    missing_share: "No price history for this product yet. Cheapr just started tracking it.",
    missing_noshare: "No price history for this product yet. Turn on anonymous price sharing in Settings to help build it.",
    loading_history: "Loading price history…", no_prices_range: "No prices in this range.",
    server_down: "Couldn't reach the Cheapr server ({err}). Prices will appear when it's back.",
    alert_below: "Alert me below", update: "Update", remove: "Remove", any_drop: "Any price drop",
    alert_set: "Alert set. We'll notify you below {price}.", alert_set_any: "Alert set. We'll notify you on any price drop.",
    already_below: "It's already below your target!", alert_removed: "Alert removed.", alert_failed: "Couldn't set alert: {err}",
    cheaper_on: "{diff} cheaper on {store}", cmp_cheaper: "{diff} cheaper", cmp_more: "{diff} more", cmp_same: "same price",
    view: "View", not_same: "Not the same product?", today: "Today", range_high_low: "{hi} high · {lo} low",
    chart_label: "Price from {lo} to {hi}",
    // coupons
    coupons_have: "Cheapr has {n} coupons for this store", coupons_have_1: "Cheapr has 1 coupon for this store",
    try_codes: "Try {n} codes", try_code: "Try 1 code", trying: "Trying {code} ({i}/{n})…", no_total: "Couldn't read the order total on this page.",
    no_coupon_worked: "No coupon lowered your total.", applied_save: "Applied {code}: you save {amount}.", dismiss_week: "Dismiss for 7 days",
    // spend
    spend_prompt: "Cheapr Spend Tracker: add up what you've spent here (stays on this device).", scan_orders: "Scan orders",
    scan_progress: "{site}: {n} orders so far…", scan_pages: "{site}: page {page} of {pages}…", sign_in_first: "Please sign in to {site} first.",
    spend_done: "{n} orders, {total} total. Open the Cheapr popup for the breakdown.", scan_failed: "Scan failed: {err}", hide: "Hide",
    // wishlist
    wl_prompt: "Track {n} items from this wishlist with Cheapr", wl_button: "Track all", wl_target: "Alert on any drop",
    wl_done: "Tracking {n} items. See them in the Cheapr popup → Alerts.", wl_failed: "Couldn't import: {err}",
    wl_progress: "Adding {i}/{n}…",
    // popup
    p_tab_page: "This page", p_tab_alerts: "Alerts", p_tab_spend: "Spending", p_tab_settings: "Settings", p_paused: "Paused",
    p_open_product: "Open a product to see its price history", p_works_on: "Cheapr works on product pages of these stores:",
    p_checks_since: "{n} price checks since {date}. Set alerts from the card on the page.", p_never_seen: "Cheapr hasn't seen this product's price before.",
    p_no_alerts: "No alerts yet", p_no_alerts_hint: "On any product page, open the Cheapr card and choose “Set alert”. Or import a wishlist.",
    p_cant_reach: "Can't reach the Cheapr server", p_change_target: "Change target for {title}", p_remove_alert: "Remove alert for {title}",
    p_now_alert_below: "{price} now · alert below ", p_now_any: "{price} now · alerts on any drop", p_dropped_on: "Dropped to {price} on {date}",
    p_above_target: "{pct}% above your target", p_at_target: "At or below target", p_new_target: "New target price",
    p_spend_title: "See what you really spend", p_spend_desc: "Add up your orders on Amazon, Flipkart, Swiggy and Zomato. Order data never leaves this browser.",
    p_spend_on: "Turn on Spend Tracker", p_spend_hint: "Open an order page, sign in, then press “Scan orders” on the page.",
    p_year_so_far: "{year} so far", p_all_time: "All time: {total} over {n} orders", p_orders_scanned: "{n} orders · scanned {date}",
    p_top: "Top: {list}", p_delete_site: "Delete {site} spending data",
    s_price_history: "Price history", s_show_card: "Show Cheapr on product pages", s_share: "Share prices anonymously",
    s_share_hint: "Store, product ID, title and price of products you open. Nothing about you.", s_alerts: "Alerts",
    s_email: "Email for price drops (optional)", s_coupons: "Coupons", s_find_coupons: "Find coupons at checkout",
    s_all_sites: "On all shopping sites", s_all_sites_hint: "By default Cheapr only runs on 20 major Indian stores. This asks Chrome for access to other sites.",
    s_spending: "Spending", s_spend_toggle: "Spend Tracker on order pages", s_spend_hint: "Order data never leaves this browser.",
    s_quiet: "Quiet", s_pause: "Pause Cheapr on all sites", s_language: "Language", s_lang_auto: "Automatic (browser)",
    s_advanced: "Advanced", s_server: "Server URL", s_privacy: "Privacy & setup", s_saved: "Saved.",
    s_perm_declined: "Permission to reach that server was declined.", s_bad_email: "That email doesn't look right.", s_bad_url: "That server URL doesn't look right.",
    s_coupons_all_on: "Coupons enabled on all sites.", s_coupons_all_off: "Coupons limited to supported stores.",
    s_hidden_on: "Hidden on {site}", s_show_again: "Show again", s_tg_on: "✓ Telegram alerts on", s_tg_label: "Get alerts on Telegram",
    s_connect: "Connect", s_disconnect: "Disconnect", s_email_confirmed: "✓ Confirmed", s_email_unavailable: "This server can't send email yet.",
    s_email_unconfirmed: "Not confirmed yet: we email a confirmation link when you set your next alert.",
    s_data: "Your data", s_export: "Export my data", s_delete: "Delete my data",
    s_delete_confirm: "Delete all your Cheapr alerts, settings and spending data, here and on the server? This can't be undone.",
    s_deleted: "Deleted. Cheapr is starting fresh.", s_failed: "Couldn't do that: {err}",
    // welcome
    w_title: "Cheapr is ready", w_lead: "Real price history, fake-discount warnings and price-drop alerts, right on the product page.",
    w_step1_t: "1. Open any product", w_step1: "on Amazon.in, Flipkart, Myntra or Ajio. Cheapr appears under the price.",
    w_step2_t: "2. See if it's a real deal", w_step2: "Lowest price ever, usual price, and whether the \"sale\" price was inflated first.",
    w_step3_t: "3. Set an alert", w_step3: "Pick a target price, or get told about any drop. Works on Telegram and email too.",
    w_choices: "Two quick choices", w_share_q: "Help build price history?", w_share_yes_t: "Share prices anonymously", w_rec: "(recommended)",
    w_share_yes: "When you open a product, Cheapr sends its store, product ID, title and price. No account, no browsing history, nothing about you. This is how everyone gets history.",
    w_share_no_t: "Don't share", w_share_no: "You'll still see history other people have shared. Products you set alerts on are still tracked.",
    w_spend_q: "Spend Tracker (optional)", w_spend_t: "Show a \"Scan orders\" button on my order pages",
    w_spend: "Adds up what you've spent on Amazon, Flipkart, Swiggy and Zomato. Order data never leaves this browser.",
    w_email: "Email for price-drop alerts (optional)", w_start: "Start saving",
    w_done: "All set. Open any product on Amazon.in or Flipkart to see Cheapr in action.",
    w_never: "What Cheapr never does", w_never1: "No affiliate links or cookie swapping. We don't earn from your purchases.",
    w_never2: "No browsing history collection. Cheapr only runs on supported shopping sites.",
    w_never3: "No selling or sharing of data. Spend and order data stay on your device.",
    w_later: "You can change any of this later in the Cheapr popup → Settings.", w_privacy: "Privacy policy",
    // notifications
    n_drop_title: "Price drop: {price}", n_drop_msg: "{title} hit your target of {target}",
    n_digest_title: "{n} of your watched items got cheaper",
  };

  const hi = {
    v_buy: "अब तक की सबसे कम कीमत", v_good: "अच्छी डील", v_fair: "ठीक-ठाक कीमत", v_wait: "आमतौर पर सस्ता मिलता है", v_new: "ट्रैकिंग शुरू",
    offline: "ऑफ़लाइन", checking: "जाँच रहे हैं…", no_history: "अभी कोई इतिहास नहीं",
    i_all_time_low: "हमारे रिकॉर्ड में अब तक की सबसे कम कीमत।",
    i_window_low: "पिछले {days} दिनों में सबसे कम कीमत।",
    i_drop: "{date} को {from} से {pct}% सस्ता हुआ।",
    i_rise: "{date} को {from} से {pct}% महँगा हुआ।",
    i_inflated_sale: "ध्यान दें: हाल ही में कीमत बढ़ाकर {peak} की गई थी। आज की \"डील\" लगभग सामान्य कीमत {usual} जितनी ही है।",
    i_inflated_mrp: "MRP बढ़ा-चढ़ाकर लिखा लगता है: हमने इसे कभी {highest} से ऊपर नहीं देखा। सामान्य कीमत पर असली छूट: {pct}%।",
    low_3m: "3 महीने में न्यूनतम", usual: "सामान्य", set_alert: "अलर्ट लगाएँ", alert_at: "{price} पर अलर्ट", show_history: "कीमत का इतिहास देखें",
    collapse: "छोटा करें", options: "Cheapr विकल्प", hide_on: "{site} पर छिपाएँ", pause_all: "सभी साइटों पर Cheapr रोकें",
    settings: "सेटिंग्स", lowest: "न्यूनतम", usual_price: "सामान्य कीमत", highest: "अधिकतम",
    checks_since: "{date} से {n} बार कीमत जाँची गई", check_since: "{date} से 1 बार कीमत जाँची गई",
    need_week: "किसी डील को परखने के लिए हमें लगभग एक हफ़्ते की कीमतें चाहिए। अलर्ट लगाइए, हम नज़र रखेंगे।",
    started_today: "Cheapr ने आज से इस प्रोडक्ट को ट्रैक करना शुरू किया है। कीमत बदलने पर ट्रेंड और लगभग एक हफ़्ते में राय दिखेगी।",
    started_on: "Cheapr ने {date} से इस प्रोडक्ट को ट्रैक करना शुरू किया है। कीमत बदलने पर ट्रेंड और लगभग एक हफ़्ते में राय दिखेगी।",
    missing_share: "इस प्रोडक्ट का अभी कोई कीमत इतिहास नहीं है। Cheapr ने अभी ट्रैक करना शुरू किया है।",
    missing_noshare: "इस प्रोडक्ट का अभी कोई कीमत इतिहास नहीं है। इतिहास बनाने में मदद के लिए सेटिंग्स में गुमनाम कीमत साझा करना चालू करें।",
    loading_history: "कीमत का इतिहास लोड हो रहा है…", no_prices_range: "इस अवधि में कोई कीमत नहीं।",
    server_down: "Cheapr सर्वर से संपर्क नहीं हो सका ({err})। सर्वर लौटते ही कीमतें दिखेंगी।",
    alert_below: "इससे कम होने पर बताएँ", update: "अपडेट करें", remove: "हटाएँ", any_drop: "कीमत ज़रा भी घटे",
    alert_set: "अलर्ट लग गया। कीमत {price} से कम होने पर हम बताएँगे।", alert_set_any: "अलर्ट लग गया। कीमत घटते ही हम बताएँगे।",
    already_below: "कीमत पहले से ही आपके लक्ष्य से कम है!", alert_removed: "अलर्ट हटा दिया गया।", alert_failed: "अलर्ट नहीं लग सका: {err}",
    cheaper_on: "{store} पर {diff} सस्ता", cmp_cheaper: "{diff} सस्ता", cmp_more: "{diff} महँगा", cmp_same: "उतनी ही कीमत",
    view: "देखें", not_same: "यह वही प्रोडक्ट नहीं है?", today: "आज", range_high_low: "अधिकतम {hi} · न्यूनतम {lo}",
    chart_label: "कीमत {lo} से {hi} तक",
    coupons_have: "इस स्टोर के लिए Cheapr के पास {n} कूपन हैं", coupons_have_1: "इस स्टोर के लिए Cheapr के पास 1 कूपन है",
    try_codes: "{n} कोड आज़माएँ", try_code: "1 कोड आज़माएँ", trying: "{code} आज़मा रहे हैं ({i}/{n})…",
    no_total: "इस पेज पर ऑर्डर की कुल राशि नहीं पढ़ी जा सकी।", no_coupon_worked: "किसी कूपन से कुल राशि कम नहीं हुई।",
    applied_save: "{code} लगाया गया: आपकी बचत {amount}।", dismiss_week: "7 दिनों के लिए हटाएँ",
    spend_prompt: "Cheapr खर्च ट्रैकर: यहाँ आपका कुल खर्च जोड़ें (डेटा इसी डिवाइस पर रहता है)।", scan_orders: "ऑर्डर स्कैन करें",
    scan_progress: "{site}: अब तक {n} ऑर्डर…", scan_pages: "{site}: {pages} में से पेज {page}…", sign_in_first: "कृपया पहले {site} में साइन इन करें।",
    spend_done: "{n} ऑर्डर, कुल {total}। पूरा ब्योरा Cheapr पॉपअप में देखें।", scan_failed: "स्कैन नहीं हो सका: {err}", hide: "छिपाएँ",
    wl_prompt: "इस विशलिस्ट के {n} आइटम Cheapr से ट्रैक करें", wl_button: "सब ट्रैक करें", wl_target: "कीमत घटते ही अलर्ट",
    wl_done: "{n} आइटम ट्रैक हो रहे हैं। इन्हें Cheapr पॉपअप → अलर्ट में देखें।", wl_failed: "इम्पोर्ट नहीं हो सका: {err}",
    wl_progress: "{n} में से {i} जोड़ रहे हैं…",
    p_tab_page: "यह पेज", p_tab_alerts: "अलर्ट", p_tab_spend: "खर्च", p_tab_settings: "सेटिंग्स", p_paused: "रुका हुआ",
    p_open_product: "कीमत का इतिहास देखने के लिए कोई प्रोडक्ट खोलें", p_works_on: "Cheapr इन स्टोर के प्रोडक्ट पेज पर काम करता है:",
    p_checks_since: "{date} से {n} बार कीमत जाँची गई। पेज पर Cheapr कार्ड से अलर्ट लगाएँ।", p_never_seen: "Cheapr ने इस प्रोडक्ट की कीमत पहले नहीं देखी है।",
    p_no_alerts: "अभी कोई अलर्ट नहीं", p_no_alerts_hint: "किसी भी प्रोडक्ट पेज पर Cheapr कार्ड खोलें और “अलर्ट लगाएँ” चुनें। या कोई विशलिस्ट इम्पोर्ट करें।",
    p_cant_reach: "Cheapr सर्वर से संपर्क नहीं हो पा रहा", p_change_target: "{title} का लक्ष्य बदलें", p_remove_alert: "{title} का अलर्ट हटाएँ",
    p_now_alert_below: "अभी {price} · इससे कम पर अलर्ट ", p_now_any: "अभी {price} · कीमत घटते ही अलर्ट", p_dropped_on: "{date} को {price} तक घटा",
    p_above_target: "आपके लक्ष्य से {pct}% ऊपर", p_at_target: "लक्ष्य पर या उससे कम", p_new_target: "नया लक्ष्य मूल्य",
    p_spend_title: "देखिए आप असल में कितना खर्च करते हैं", p_spend_desc: "Amazon, Flipkart, Swiggy और Zomato के ऑर्डर जोड़ें। ऑर्डर डेटा इस ब्राउज़र से बाहर नहीं जाता।",
    p_spend_on: "खर्च ट्रैकर चालू करें", p_spend_hint: "कोई ऑर्डर पेज खोलें, साइन इन करें, फिर पेज पर “ऑर्डर स्कैन करें” दबाएँ।",
    p_year_so_far: "{year} में अब तक", p_all_time: "कुल: {n} ऑर्डर में {total}", p_orders_scanned: "{n} ऑर्डर · {date} को स्कैन किया",
    p_top: "सबसे ज़्यादा: {list}", p_delete_site: "{site} का खर्च डेटा हटाएँ",
    s_price_history: "कीमत का इतिहास", s_show_card: "प्रोडक्ट पेज पर Cheapr दिखाएँ", s_share: "कीमतें गुमनाम रूप से साझा करें",
    s_share_hint: "आपके खोले प्रोडक्ट का स्टोर, प्रोडक्ट ID, नाम और कीमत। आपके बारे में कुछ नहीं।", s_alerts: "अलर्ट",
    s_email: "कीमत घटने पर ईमेल (वैकल्पिक)", s_coupons: "कूपन", s_find_coupons: "चेकआउट पर कूपन खोजें",
    s_all_sites: "सभी शॉपिंग साइटों पर", s_all_sites_hint: "डिफ़ॉल्ट रूप से Cheapr सिर्फ़ 20 बड़े भारतीय स्टोर पर चलता है। इससे Chrome दूसरी साइटों की अनुमति माँगेगा।",
    s_spending: "खर्च", s_spend_toggle: "ऑर्डर पेज पर खर्च ट्रैकर", s_spend_hint: "ऑर्डर डेटा इस ब्राउज़र से बाहर नहीं जाता।",
    s_quiet: "शांत मोड", s_pause: "सभी साइटों पर Cheapr रोकें", s_language: "भाषा", s_lang_auto: "अपने आप (ब्राउज़र के अनुसार)",
    s_advanced: "उन्नत", s_server: "सर्वर URL", s_privacy: "निजता और सेटअप", s_saved: "सहेजा गया।",
    s_perm_declined: "उस सर्वर तक पहुँचने की अनुमति नहीं मिली।", s_bad_email: "यह ईमेल सही नहीं लगता।", s_bad_url: "यह सर्वर URL सही नहीं लगता।",
    s_coupons_all_on: "सभी साइटों पर कूपन चालू।", s_coupons_all_off: "कूपन सिर्फ़ समर्थित स्टोर पर।",
    s_hidden_on: "{site} पर छिपा हुआ", s_show_again: "फिर दिखाएँ", s_tg_on: "✓ Telegram अलर्ट चालू", s_tg_label: "Telegram पर अलर्ट पाएँ",
    s_connect: "जोड़ें", s_disconnect: "हटाएँ", s_email_confirmed: "✓ पुष्टि हो गई", s_email_unavailable: "यह सर्वर अभी ईमेल नहीं भेज सकता।",
    s_email_unconfirmed: "अभी पुष्टि नहीं हुई: अगला अलर्ट लगाने पर हम पुष्टि का लिंक ईमेल करेंगे।",
    s_data: "आपका डेटा", s_export: "मेरा डेटा एक्सपोर्ट करें", s_delete: "मेरा डेटा हटाएँ",
    s_delete_confirm: "आपके सारे Cheapr अलर्ट, सेटिंग्स और खर्च डेटा, यहाँ और सर्वर पर, हटा दें? यह वापस नहीं होगा।",
    s_deleted: "हटा दिया गया। Cheapr नए सिरे से शुरू हो रहा है।", s_failed: "यह नहीं हो सका: {err}",
    w_title: "Cheapr तैयार है", w_lead: "प्रोडक्ट पेज पर ही असली कीमत का इतिहास, नकली छूट की चेतावनी और कीमत घटने के अलर्ट।",
    w_step1_t: "1. कोई भी प्रोडक्ट खोलें", w_step1: "Amazon.in, Flipkart, Myntra या Ajio पर। Cheapr कीमत के नीचे दिखेगा।",
    w_step2_t: "2. देखें कि डील असली है या नहीं", w_step2: "अब तक की सबसे कम कीमत, सामान्य कीमत, और क्या \"सेल\" से पहले कीमत बढ़ाई गई थी।",
    w_step3_t: "3. अलर्ट लगाएँ", w_step3: "लक्ष्य कीमत चुनें, या कीमत ज़रा भी घटने पर सूचना पाएँ। Telegram और ईमेल पर भी।",
    w_choices: "दो छोटे से सवाल", w_share_q: "कीमत का इतिहास बनाने में मदद करेंगे?", w_share_yes_t: "कीमतें गुमनाम रूप से साझा करें", w_rec: "(सुझाया गया)",
    w_share_yes: "जब आप कोई प्रोडक्ट खोलते हैं, Cheapr उसका स्टोर, प्रोडक्ट ID, नाम और कीमत भेजता है। कोई अकाउंट नहीं, कोई ब्राउज़िंग इतिहास नहीं, आपके बारे में कुछ नहीं। इसी से सबको इतिहास मिलता है।",
    w_share_no_t: "साझा न करें", w_share_no: "दूसरों का साझा किया इतिहास आपको फिर भी दिखेगा। जिन प्रोडक्ट पर आप अलर्ट लगाएँगे, वे ट्रैक होते रहेंगे।",
    w_spend_q: "खर्च ट्रैकर (वैकल्पिक)", w_spend_t: "मेरे ऑर्डर पेज पर \"ऑर्डर स्कैन करें\" बटन दिखाएँ",
    w_spend: "Amazon, Flipkart, Swiggy और Zomato पर आपका कुल खर्च जोड़ता है। ऑर्डर डेटा इस ब्राउज़र से बाहर नहीं जाता।",
    w_email: "कीमत घटने के अलर्ट के लिए ईमेल (वैकल्पिक)", w_start: "बचत शुरू करें",
    w_done: "सब तैयार है। Cheapr को काम करते देखने के लिए Amazon.in या Flipkart पर कोई प्रोडक्ट खोलें।",
    w_never: "Cheapr ये कभी नहीं करता", w_never1: "कोई एफ़िलिएट लिंक या कुकी की अदला-बदली नहीं। आपकी ख़रीदारी से हमारी कोई कमाई नहीं होती।",
    w_never2: "ब्राउज़िंग इतिहास इकट्ठा नहीं करता। Cheapr सिर्फ़ समर्थित शॉपिंग साइटों पर चलता है।",
    w_never3: "डेटा न बेचा जाता है, न साझा किया जाता है। खर्च और ऑर्डर डेटा आपके डिवाइस पर ही रहता है।",
    w_later: "आप ये सब बाद में Cheapr पॉपअप → सेटिंग्स में बदल सकते हैं।", w_privacy: "निजता नीति",
    n_drop_title: "कीमत घटी: {price}", n_drop_msg: "{title} आपके लक्ष्य {target} तक पहुँच गया",
    n_digest_title: "आपकी नज़र वाले {n} आइटम सस्ते हुए",
  };

  const STRINGS = { en, hi };
  let lang = "en";

  function pick(setting) {
    if (setting === "en" || setting === "hi") return setting;
    const nav = (globalThis.navigator?.language || "en").toLowerCase();
    return nav.startsWith("hi") ? "hi" : "en";
  }

  function t(key, vars = {}) {
    const s = STRINGS[lang]?.[key] ?? en[key] ?? key;
    return s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? `{${k}}`));
  }

  async function load() {
    const { lang: setting = "auto" } = await chrome.storage.sync.get("lang");
    lang = pick(setting);
    // Extension pages only: content scripts share the host page's document and must not change its lang.
    if (globalThis.document && location.protocol === "chrome-extension:") document.documentElement.lang = lang;
    return lang;
  }

  // Fill [data-i18n] (text) and [data-i18n-ph] (placeholder) in extension pages.
  function apply(root = document) {
    for (const el of root.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
    for (const el of root.querySelectorAll("[data-i18n-ph]")) el.placeholder = t(el.dataset.i18nPh);
  }

  globalThis.CheaprI18n = { t, load, apply, pick, STRINGS, get lang() { return lang; } };
})();
