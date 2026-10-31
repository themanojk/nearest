"""Review cues, not diagnoses or proof of abuse. Matched on ASR transcripts."""

# Signals carry original utterance offsets for aggregation and audio review.
# Avoid bare ambiguous words (sale, secret, drugs, suicide) in new rules.
CHILD_SAFETY_RULES = [
    (
        "bullying",
        "medium",
        r"\b(?:they keep calling me names|they keep making fun of me"
        r"|they won.t let me play|they keep taking my lunch|sab mera mazak udate"
        r"|mera mazaak udate)\b|मेरा\s+मज़ाक\s+उड़ाते|मेरा\s+मजाक\s+उड़ाते",
    ),
    (
        "neglect_disclosure",
        "medium",
        r"\b(?:they won.t give me food|they do not give me food"
        r"|i am locked outside|i am alone and cannot find my parents"
        r"|mujhe khana nahi dete)\b|मुझे\s+खाना\s+नहीं\s+देते",
    ),
    (
        "insult",
        "medium",
        r"\b(?:badtameez|badtamiz|bad tameez|besharam|bewakuf|bewakoof|nalayak"
        r"|nikamma|nikammi|gadha|gadhi|saale|saaley|saley|salay|sala|saali)\b"
        r"|(?<!\w)(?:बदतमीज़"
        r"|बदतमीज|बेशर्म|बेवकूफ|बेवकूफ़|नालायक|निकम्मा|निकम्मी|साले|साली)(?!\w)",
    ),
    (
        "insult",
        "medium",
        r"\b(?:you are worthless|you are a failure|everyone hates you"
        r"|nobody wants you|you do not belong here|tu sale|tum sale|abe sale"
        r"|oye sale)\b",
    ),
    (
        "threat",
        "high",
        r"\b(?:tujhe|tumhe|tujhko|tumko)\s+(?:maar|mar|peet)\s+(?:dunga|doonga"
        r"|dungi|denge)\b|(?:तुझे|तुम्हें|तुमको)\s+(?:मार|पीट)\s+(?:दूंगा|दूँगा"
        r"|दूंगी|दूँगी|देंगे)",
    ),
    (
        "violence_disclosure",
        "high",
        r"\b(?:mujhe|mereko)\s+(?:maarta|marta|maarti|marti|peetta|peet ta)\b"
        r"|\b(?:he|she|they)\s+(?:touched my private parts|locked me in"
        r"|forced me to undress)\b",
    ),
    (
        "distress",
        "medium",
        r"\b(?:mujhe mat chuo|mujhe mat chhoo|mujhe akela chhod|mujhe dar lagta"
        r"|i am afraid to go to school|i feel unsafe)\b|मुझे\s+(?:मत\s+छुओ"
        r"|अकेला\s+छोड़)|स्कूल\s+जाने\s+से\s+डर",
    ),
    (
        "secrecy_request",
        "medium",
        r"\b(?:kisi ko mat batana|mummy ko mat batana|papa ko mat batana"
        r"|yeh hamara secret hai)\b|(?:किसी|मम्मी|पापा)\s+को\s+मत\s+बताना",
    ),
    (
        "inappropriate_request",
        "high",
        r"\b(?:send me (?:a )?nude|send nudes|show me your underwear"
        r"|touch my private parts|kapde utaro|kapre utaro|apne kapde utaro"
        r"|nangi photo bhejo|nangi tasveer bhejo)\b|(?:नंगी|नग्न)\s+(?:फोटो"
        r"|तस्वीर)\s+भेज|मेरे\s+प्राइवेट\s+पार्ट",
    ),
    (
        "coercion",
        "high",
        r"\b(?:give me (?:your )?money or|do what i say or i will"
        r"|if you tell anyone i will|i will share your (?:photos"
        r"|pictures) unless|paise de warna)\b|पैसे\s+दे\s+वरना",
    ),
    (
        "unsafe_contact",
        "medium",
        r"\b(?:meet me alone|come alone and don.t tell|send me your home address"
        r"|send me your password|tell me your password|akele milne aao"
        r"|apna password batao)\b|अकेले\s+मिलने\s+आओ|अपना\s+पासवर्ड\s+बताओ",
    ),
    (
        "substance_pressure",
        "medium",
        r"\b(?:try this cigarette|smoke this cigarette|take these drugs"
        r"|drink this alcohol|cigarette pee ke dekh|sharab pee lo)\b"
        r"|सिगरेट\s+पी\s+के\s+देख|शराब\s+पी\s+लो",
    ),
    (
        "medical_distress",
        "high",
        r"\bi (?:can.t|cannot) breathe\b|\bi am choking\b|\bsaans nahi aa rahi\b"
        r"|सांस\s+नहीं\s+आ\s+रही|साँस\s+नहीं\s+आ\s+रही",
    ),
    (
        "self_harm",
        "high",
        r"\b(?:main marna chahta hoon|main marna chahti hoon|mujhe jeena nahi"
        r"|main khud ko maar dunga|main khud ko maar dungi)\b",
    ),
    (
        "imminent_danger",
        "high",
        r"\b(?:koi mera peecha kar raha|koi mera picha kar raha"
        r"|mujhe zabardasti le ja rahe)\b|मुझे\s+जबरदस्ती\s+ले\s+जा",
    ),
]

# Only explicit reporting/education frames downgrade a cue to review. Never
# suppress a child's reported disclosure (e.g. "he said I will hurt you").
EDUCATIONAL_FRAME = (
    r"\b(?:the (?:teacher|lesson|book) (?:says|explains)|"
    r"the (?:word|phrase) .{0,40}(?:means|is rude)|"
    r"what does .{0,40} mean|in (?:the|this) (?:movie|story|game))\b"
    r"|इस\s+शब्द\s+का\s+मतलब"
)
