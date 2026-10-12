package io.github.haardhikk.charm

import org.json.JSONObject

/**
 * Where one utterance goes (pure, unit-tested):
 * 1. obvious phrases → a fixed command by keyword rules (instant, no model);
 * 2. otherwise Needle picks a command; it acts only if the command is in [ACTIONS] with confidence ≥ [ACTION_MIN_CONFIDENCE];
 * 3. everything else (a question, chatter, `answer_question`, `none`, a low score) → the chat model for a short spoken answer.
 * Rules match the whole normalised utterance, so a long, messy transcript never triggers an action by accident.
 */
object Router {

    /** Commands the robot acts out. `answer_question` is not one: questions go to the chat model. */
    val ACTIONS = setOf("help", "smalltalk", "remember_note", "remember_photo", "recall_note", "set_timer", "timer", "dance", "take_photo", "describe_photo", "where_am_i", "navigate_to", "sun", "mute", "unmute", "metal", "stop", "look_up", "fun", "transit", "next_departure", "set_home", "forget_context") + SenseFormat.COMMANDS

    /** Needle's scores run low even when it is right (0.1–0.4 seen on correct picks); below this it is guessing. */
    const val ACTION_MIN_CONFIDENCE = 0.9 // the fine-tuned Needle: 153/200 right and no wrong actions on the held-out sets at 0.9 (0.5 gave 6 wrong actions)

    enum class Via { RULE, NEEDLE, CHAT }

    /** Words that carry no meaning for routing, dropped anywhere in the utterance. */
    private val FILLERS = Regex("\\b(um+|uh+|uhm+|erm*|hmm+|ah+|please|pls)\\b")

    /**
     * Greetings and wake words dropped from the start ("hey val, …", "okay so …"), and polite tails from the end.
     * The character is Val; Moonshine also hears the name as "vel" or "well" (both here), or as "al"/"hal"; right after
     * a greeting these become "val" ([WEAK_NAMES]: "hey well" is a greeting, a bare "well" is not).
     */
    private val LEADING = setOf("hey", "he", "hay", "high", "hai", "hi", "hello", "ok", "okay", "yo", "so", "well", "alright", "oh", "charm", "charmy", "robot", "buddy", "val", "vel") // "he"/"hay": how the speech models hear "hey" (seen on the phone)
    private val TRAILING = setOf("now", "right now", "thanks", "charm", "thank you", "for me", "val", "vel")
    /** "…, okay?" at the end of a request; kept after words it answers ("are you okay", "is it alright"). */
    private val POLITE_TAIL = setOf("ok", "okay", "alright")
    private val KEEPS_TAIL = setOf("you", "be", "is", "are", "it", "feel", "feeling", "look", "looks", "doing", "all", "that's", "it's", "i'm")
    private val GREETING_WORDS = setOf("hey", "hi", "hello", "ok", "okay", "high", "hai")
    private val WEAK_NAMES = setOf("al", "hal", "well")

    /** Lowercase, plain ASCII apostrophes, no punctuation, fillers and wake words gone, single spaces. */
    fun normalize(text: String): String {
        var words = text.lowercase()
            .replace('’', '\'')
            .replace(Regex("\\b(what|where|who|how|that|it|there|let)s\\b"), "$1's") // "whats" from the speech model means "what's"
            .replace(Regex("\\byoure\\b"), "you're")
            .replace(Regex("\\b(do|is|ca)nt\\b"), "$1n't") // "dont", "isnt", "cant"
            .replace(Regex("\\bim\\b"), "i'm")
            .replace(Regex("[^a-z0-9äöüß'. ]"), " ")
            .replace(Regex("(?<!\\d)\\.|\\.(?!\\d)"), " ") // a dot stays only inside a number ("1.5 minutes")
            .replace(FILLERS, " ")
            .split(' ')
            .filter { it.isNotEmpty() }
        // A bare greeting stays as it is (chat answers it); strip only while something follows.
        while (words.size > 1) {
            words = when {
                words[0] in GREETING_WORDS && words[1] in WEAK_NAMES -> listOf("val") + words.drop(2) // "hey al" → "val"
                words[0] in LEADING -> words.drop(1)
                else -> break
            }
        }
        while (words.size > 1) {
            words = when {
                words.size > 2 && words.takeLast(2).joinToString(" ") in TRAILING -> words.dropLast(2)
                words.last() in TRAILING -> words.dropLast(1)
                words.size > 2 && words.last() in POLITE_TAIL && words[words.size - 2] !in KEEPS_TAIL -> words.dropLast(1)
                else -> break
            }
        }
        // "What's the time" is often heard as "watch the time" or "waters to …".
        // Seen on the phone: "where am I currently" → "veramai currently", "where is Dresden Hbf" → "there is dresden …".
        val joined = MISHEARD_WHERE_AM_I.replaceFirst(words.joinToString(" "), "where am i")
            .replace(MISHEARD_WHERE_IS, "where is ")
        // Seen in a loud hall: "cancel the timer" → "council timer", "cancelled a timer", "timur gansen".
        if (MISHEARD_TIMER_CANCEL.matches(joined)) return "cancel the timer"
        // "find metal" → "fine metal", "this is a fine matter", "make it to find metal".
        if (MISHEARD_FIND_METAL.matches(joined)) return "find metal"
        return MISHEARD_WHATS.replaceFirst(joined, "what's the ")
    }
    private const val HEARD_TIMER = "(?:timer|timers|timur|timor|tymer|tima)"
    private const val HEARD_CANCEL = "(?:cancel|cancels|cancelled|canceled|cancelling|canceling|council|counsel|cancer|kansen|gansen)"
    private val MISHEARD_FIND_METAL = Regex("^(?!.*\\b(?:stop|off|don't|dont|not|no|close|end|quit)\\b)(?:[a-z']+ ){0,6}(?:fine|find|fined) (?:metal|metals|matter)$")
    private val MISHEARD_TIMER_CANCEL = Regex(
        "^(?:$CAN(?:$HEARD_CANCEL|stop|end|kill|clear)(?: the| a| my)? $HEARD_TIMER|$HEARD_TIMER (?:$HEARD_CANCEL|off|stop))$",
    )
    private val MISHEARD_WHERE_AM_I = Regex("^(?:veramai|verami|where ami|wear am i|were am i|wherever am i)\\b")
    private val MISHEARD_WHERE_IS = Regex("^(?:there is|there's|wear is|we're is|where's is|were is) (?=(?:the )?(?:dresden|[a-z]+(?:platz|bahnhof|kirche|garten|strasse|straße)\\b))")
    private val MISHEARD_WHATS = Regex("^(?:watch|waters?|words|wots) (?:the|to) ")

    private const val CAN = "(?:(?:can|could|will|would) you |let's |lets |i want you to |go )?"

    private val DESCRIBE = Regex(
        "^$CAN(?:what(?:'s| is) (?:this|that|it)(?: thing| object| here| in front of me)?|what am i (?:looking at|holding)|" +
            "what do you see|(?:can you )?see this|what(?:'s| is) in front of me|tell me what (?:this|that) is|look at this|identify this|" +
            "describe (?:this|that|it|what you see)|(?:do you know|can you tell me) what (?:this|that) is|what does (?:this|that|it) say|" +
            "(?:can you )?read (?:this|that)(?: for me)?|what (?:kind|type|sort) of \\w+ is (?:this|that)|what colou?r is (?:this|that)|" +
            "what(?:'s| is) that (?:building|tower|church|statue|bridge))$",
    )
    private val PHOTO = Regex(
        "^$CAN(?:take|snap|shoot|make) (?:a |me a |another )?(?:photo|picture|pic|selfie|snapshot)(?: of (?:this|me|that|us))?$|" +
            "^$CAN(?:open|start|turn on|use) (?:the |your )?camera$|^(?:the )?camera$|^say cheese$",
    )
    /** The map with our dot. "Where am I" alone is spoken instead ([SENSES] → place). */
    private val WHERE_AM_I = Regex("^(?:show me where (?:i am|we are)|i(?:'m| am) lost|we(?:'re| are) lost|show me (?:on )?the map|find me on the map|show me the map|(?:open|show)(?: me)?(?: the)? map)$")

    /**
     * Questions answered from the phone's own senses (Senses.kt fills the values, assistant.ts says them), checked
     * before the note rules so "what's my speed" is never a note. Whole sentences only.
     */
    private val SENSES: List<Pair<String, Regex>> = listOf(
        "clock" to Regex(
            "^(?:what time is it|what(?:'s| is) the time|(?:do you know|can you tell me|tell me) (?:what )?the time(?: is)?|" +
                "what(?:'s| is) the time right|got the time|time check)$",
        ),
        "day" to Regex("^(?:what day is (?:it|today)(?: today)?|what(?:'s| is) today|which day is (?:it|today)|what day of the week is it|is it the weekend)$"),
        "date" to Regex("^(?:what(?:'s| is) (?:the |today's )?date(?: today)?|what date is (?:it|today)(?: today)?|what(?:'s| is) today's date|which date is it)$"),
        "battery" to Regex(
            "^(?:how much battery(?: do you have| have you got| is left| left| do we have)?|what(?:'s| is) (?:your|the) battery(?: level| at)?|" +
                "how(?:'s| is) (?:your|the) battery|battery(?: level| status)?|how charged are you|do you need (?:a )?(?:charge|charging)|" +
                "are you (?:charging|plugged in|low on battery)|is (?:it|the phone) charging)$",
        ),
        "place" to Regex(
            "^(?:where am i(?: right)?|where are we(?: right)?|where are we at|where is this|what(?:'s| is) (?:this place|around here|nearby|near us)|" +
                "what place is this|what part of (?:dresden|town|the city) (?:is this|are we in)|" +
                "what(?:'s| is) my (?:current )?(?:location|position|address)|what street (?:is this|are we on|am i on))$",
        ),
        "sky" to Regex(
            "^(?:how many satellites(?: can you see| do you see| are there| can you hear| are up there)?|" +
                "can you see (?:the sky|any satellites|satellites|the satellites)|do you have (?:gps|a fix|a gps fix|a signal|gps signal)|" +
                "is (?:the )?gps working|any satellites)$",
        ),
        "altitude" to Regex(
            "^(?:how high (?:are we|am i|up are we|up am i)|what(?:'s| is) (?:the |our |my )?(?:altitude|elevation|height above sea level)|" +
                "what altitude are we(?: at)?|how far above sea level are we)$",
        ),
        "speed" to Regex(
            "^(?:how fast (?:are we|am i)(?: walking| going| moving)?|what(?:'s| is) (?:our|my) (?:speed|walking speed|pace)|" +
                "which way are we (?:going|walking|heading)|are we moving)$",
        ),
        "dark" to Regex(
            "^(?:is it (?:dark|light|night|day|daytime|nighttime|night time|day time)(?: outside| out)?(?: yet| now| already)?|" +
                "is the sun (?:up|down|out)(?: yet| now)?|has the sun (?:set|gone down|come up|risen)(?: yet)?)$",
        ),
        "awake" to Regex("^(?:how long have you been (?:awake|on|running|up|alive)|when did you wake up|how long are you awake)$"),
    )

    /**
     * A short question the exact patterns missed ("what's the day today", "hey val what time is it now"): a few
     * unmistakable keywords plus a question word. Only for short sentences, so a long question about dates or
     * batteries in general still goes to the chat model.
     */
    internal fun looseSense(text: String): String? {
        val words = text.split(' ').filter { it.isNotEmpty() }
        if (words.size > 7) return null
        val w = words.toSet()
        val asks = w.any { it in QUESTION_WORDS }
        val clockOnly = w.all { it in CLOCK_WORDS } // "what time does the Zwinger open" is not a clock question
        return when {
            "timer" in w || "timers" in w -> null // the timer rules own these
            ("battery" in w || "charged" in w || "charge" in w && asks) && (words.size <= 6 || "you" in w) -> "battery"
            !clockOnly -> if ("where" in w && ("we" in w || "i" in w) && words.size <= 5 && w.none { it in NOT_CLOCK }) "place" else null
            "date" in w || "today's" in w -> "date"
            "day" in w -> "day"
            "time" in w -> "clock"
            else -> null
        }
    }
    private val NOT_CLOCK = setOf("left", "remaining", "sunset", "sunrise", "sun", "moon", "dark", "in", "until", "till", "since", "ago")
    private val QUESTION_WORDS = setOf("what", "what's", "whats", "which", "tell", "know", "how", "how's", "is")
    /** The only words a loose clock question may have ("what's the time right now", "time", "what day is it today"). */
    private val CLOCK_WORDS = setOf(
        "what", "what's", "time", "day", "date", "is", "it", "the", "now", "right", "current", "today", "today's", "tell", "me",
        "know", "do", "you", "please", "my",
    )

    /** A senses command for a whole sentence: "what day is it" → clock {ask: day}; "where am i" → place. */
    internal fun sense(text: String): Command? {
        if (text.length > 60) return null
        val kind = SENSES.firstOrNull { it.second.matches(text) }?.first ?: looseSense(text) ?: return null
        return when (kind) {
            "clock", "day", "date" -> cmd("clock", JSONObject().put("ask", if (kind == "clock") "time" else kind))
            "battery" -> cmd("battery", JSONObject().put("ask", if (Regex("charg|plugged").containsMatchIn(text) && !text.startsWith("how")) "charging" else "level"))
            else -> cmd(kind)
        }
    }
    /** "Look at the sky": Val looks up and scans it (a page reaction only). A rule only: Needle has no such tool. */
    private val LOOK_UP = Regex(
        "^$CAN(?:look|looking|gaze|peek) (?:up(?: at the (?:sky|stars|clouds|moon)| there| into the sky)?|at the (?:sky|stars|clouds|moon)|into the sky)$",
    )
    private val NAVIGATE = Regex(
        "^$CAN(?:take|bring|guide|walk|lead|get) (?:me |us )?to (.+)$|^(?:navigate|directions|show me the way|the way) to (.+)$|" +
            "^how (?:do|can) (?:i|we) (?:get|walk|go) to (.+)$|^(?:give me |get me )?directions to (.+)$|" +
            "^(?:i (?:want|would like|wanna|need) to (?:go|get|walk) to|i'd like to (?:go|get|walk) to|let's (?:go|walk|head) to|" +
            "navigate (?:me |us )to|(?:can you )?show me how to get to) (.+)$",
    )
    /** Asks that are navigation only when the slot is a place we know ("how far is the moon" stays a question). */
    private val PLACE_ASK = Regex("^how far(?: away)? is (.+?)(?: from here)?$|^which way is (.+)$|^where(?:'s| is) (?!my )(.+)$")

    /** "Where is the nearest toilet", "find a cafe nearby", "I need a pharmacy": the map searches near the dot. */
    private val NEARBY = Regex(
        "^(?:where(?:'s| is) )?(?:the |a )?(?:nearest|closest|next) $AMENITY$|^$CAN(?:find|show) (?:me )?(?:a |an |the |some )?(?:nearest |closest )?$AMENITY" +
            "(?: nearby| near me| near here| around here| close by)?$|^(?:i need|we need|i'm looking for|is there) (?:a |an |the |some )?$AMENITY(?: nearby| near here| around here)?$",
    )
    private val AMENITY_WORDS = mapOf("bathroom" to "toilet", "restroom" to "toilet", "loo" to "toilet", "coffee" to "cafe", "café" to "cafe", "chemist" to "pharmacy")

    /** Misheard place names are repaired against the map's names (PlaceFix); the full list loads on first use. */
    @Volatile private var places: Lazy<PlaceFix> = lazy { PlaceFix.core() }

    /** Installs the full place list (MainActivity: `PlaceFix.fromAssets(assets)`); it is read lazily on the first navigation. */
    fun usePlaces(load: () -> PlaceFix) {
        places = lazy(load)
    }

    /** Loads the place list now (off the voice path); returns how many names it holds. */
    fun warmPlaces(): Int = runCatching { places.value.size }.getOrDefault(0)

    /** The repaired place for a navigation slot, or null when it is not a place we know. */
    internal fun fixPlace(raw: String): PlaceFix.Fix? = runCatching { places.value.resolve(raw) }.getOrNull()

    /** A place slot as args: the repaired name (with `confirm` and `heard` when unsure), or the words as heard. */
    private fun placeArgs(key: String, raw: String, fix: PlaceFix.Fix? = fixPlace(raw)): JSONObject {
        val args = JSONObject().put(key, fix?.name ?: raw)
        if (fix != null && fix.confirm) args.put("confirm", true).put("heard", raw)
        return args
    }

    /** "Take me there" with the place from memory (ConversationMemory.isThere): a walking route, the name repaired like a spoken one. */
    fun navigateTo(place: String): Command = cmd("navigate_to", placeArgs("place", place))

    private val RECALL = Regex(
        "^(?:where(?:'s| is| are) my (.+)|what(?:'s| is| was| were) my (.+)|where did i (?:put|leave|park) (?:my )?(.+)|" +
            "do you remember (?:where |what )?(?:my )?(.+)|remember (?:where|what) (?:my )?(.+))$",
    )
    /** "Remember this" after a photo: the page saves the last photo's caption as a note (checked before RECALL and REMEMBER). */
    private val REMEMBER_PHOTO = Regex(
        "^(?:$CAN)?(?:remember|save|keep|note|don't forget|do not forget|memorize|memorise) " +
            "(?:this|that|it|this one|what (?:you|we) (?:just )?(?:saw|see|looked at)|" +
            "(?:this|that|the) (?:photo|picture|pic|thing|object))$",
    )
    /** "Forget that", "new topic": Val drops the conversation memory (ConversationMemory.kt); notes stay. */
    private val FORGET = Regex(
        "^(?:$CAN)?(?:forget (?:that|it|about (?:it|that)|what (?:i|we) (?:just )?said|what we talked about|our conversation|the conversation)|" +
            "(?:a |let's )?(?:new|different|another) (?:topic|subject)|change (?:the )?(?:topic|subject)|let's talk about something else|" +
            "start over|fresh start|never ?mind)$",
    )
    private val REMEMBER = Regex("^(?:remember(?! when| how| the time)|note|don't forget|do not forget|keep in mind)(?: that)? (.+)$")
    /** Questions about Val or the user's feelings: never a note lookup ("what's my name", "what's my favourite food"). */
    private val NOT_NOTES = Regex("^(?:name|mood|favou?rite)\\b")
    private val HELP = Regex("^(?:what can you do|what do you do|help|help me|what can i (?:ask|say)(?: you)?)$")
    private val DANCE = Regex("^$CAN(?:do )?(?:a |a little |your |some )?(?:dance|dancing|boogie|happy dance)(?: dance| for me| move)?$|^show me (?:a |your )?(?:dance|moves)$|^(?:dance|let's dance)(?: with me)?$")

    /** Sunrise, sunset, dark, the moon: the page shows the sun card (offline sun math, sun.ts). A rule only: Needle has no such tool. */
    private val SUN = Regex(
        "^(?:$CAN)?(?:tell me )?when(?:'s| is| does| will)? (?:the )?(?:sunset|sunrise|sun (?:set|rise|go down|come up))(?: today| tonight| tomorrow)?$|" +
            "^how (?:long|much time) (?:is (?:it |there |left )?)?(?:until|till|til|before) (?:it (?:gets |is )?|it's )?(?:dark|sunset|sunrise|nightfall)$|" +
            "^(?:what(?:'s| is) )?(?:the )?(?:moon phase|phase of the moon)(?: today| tonight)?$|^what phase is the moon(?: in)?(?: today| tonight)?$|" +
            "^how full is the moon(?: today| tonight)?$|^(?:what time is |what's the )?(?:sunset|sunrise)(?: time)?(?: today| tonight| tomorrow)?$",
    )
    private val MUTE = Regex("^(?:$CAN)?(?:be quiet|keep quiet|quiet|be silent|silence|mute|mute yourself|stop talking|shut up|no more talking|voice off|text only)$")
    private val UNMUTE = Regex("^(?:$CAN)?(?:talk to me|unmute|unmute yourself|voice on|speak|speak again|talk again|you can talk(?: again)?|turn (?:your|the) voice (?:back )?on)$")

    /** The metal detector (the magnetometer, Metal.kt). A rule only: Needle has no such tool. */
    private val METAL = Regex(
        "^$CAN(?:find|detect|look for|search for|sniff out|hunt for) (?:some |any |the |a )?(?:metal|metals|magnets?|iron)(?: for me| around here| here)?$|" +
            "^(?:(?:start|open|turn on|use) )?(?:the |a |your )?metal detector(?: mode| on)?$|^(?:be a|be my) metal detector$",
    )

    /** Ends the metal detector (the page ignores it otherwise). Whole short sentences only. */
    private val STOP = Regex("^(?:stop|stop it|stop that|stop searching|stop looking|stop sniffing|stop detecting|enough|that's enough|that is enough|i'm done|im done|we're done|all done|done|(?:stop|close|exit|turn off) (?:the )?metal detector)$")

    private val NUMBER_WORDS = mapOf(
        "a" to 1, "an" to 1, "one" to 1, "two" to 2, "three" to 3, "four" to 4, "five" to 5, "six" to 6, "seven" to 7,
        "eight" to 8, "nine" to 9, "ten" to 10, "eleven" to 11, "twelve" to 12, "thirteen" to 13, "fourteen" to 14,
        "fifteen" to 15, "sixteen" to 16, "seventeen" to 17, "eighteen" to 18, "nineteen" to 19, "twenty" to 20,
        "thirty" to 30, "forty" to 40, "fifty" to 50, "sixty" to 60, "seventy" to 70, "eighty" to 80, "ninety" to 90,
        "a couple of" to 2, "a couple" to 2, "couple of" to 2, "a few" to 3,
    )

    /** "5", "five", "twenty five", "a" → minutes count; null if it is not a number. */
    internal fun number(words: String): Double? {
        words.toDoubleOrNull()?.let { return it }
        val parts = words.split(" ")
        if (parts.size == 2) {
            val tens = NUMBER_WORDS[parts[0]]
            val ones = NUMBER_WORDS[parts[1]]
            if (tens != null && ones != null && tens >= 20 && tens % 10 == 0 && ones in 1..9) return (tens + ones).toDouble()
        }
        return NUMBER_WORDS[words]?.toDouble()
    }

    private fun cmd(name: String, args: JSONObject = JSONObject()) = Command(name, args, 1.0)

    private fun place(raw: String) = raw.removePrefix("the ").removeSuffix(" from here").removeSuffix(" please").trim()

    /** A command for an obvious phrase in the normalised utterance, or null when Needle must decide. */
    fun rule(text: String): Command? {
        if (text.isBlank() || text.length > 120) return null
        if (FORGET.matches(text)) return cmd("forget_context") // ConversationMemory: start a new topic
        DESCRIBE.find(text)?.let { return cmd("describe_photo") }
        PHOTO.find(text)?.let { return cmd("take_photo") }
        WHERE_AM_I.find(text)?.let { return cmd("where_am_i") }
        transit(text)?.let { return it } // before senses ("what time is the next tram"), notes and plain walking
        sense(text)?.let { return it }
        if (LOOK_UP.matches(text)) return cmd("look_up")
        NEARBY.matchEntire(text)?.let { m ->
            val what = m.groupValues.drop(1).first { it.isNotEmpty() }
            return cmd("navigate_to", JSONObject().put("place", AMENITY_WORDS[what] ?: what))
        }
        NAVIGATE.find(text)?.let { m ->
            val p = place(m.groupValues.drop(1).first { it.isNotEmpty() })
            return if (p.isEmpty()) null else cmd("navigate_to", placeArgs("place", p))
        }
        PLACE_ASK.matchEntire(text)?.let { m ->
            val p = place(m.groupValues.drop(1).first { it.isNotEmpty() })
            val fix = fixPlace(p)
            if (fix != null) return cmd("navigate_to", placeArgs("place", p, fix))
        }
        if (REMEMBER_PHOTO.matches(text)) return cmd("remember_photo")
        RECALL.find(text)?.let { m ->
            val topic = m.groupValues.drop(1).first { it.isNotEmpty() }
            if (NOT_NOTES.containsMatchIn(topic)) return null
            return cmd("recall_note", JSONObject().put("topic", topic))
        }
        REMEMBER.find(text)?.let { m -> return cmd("remember_note", JSONObject().put("text", m.groupValues[1])) }
        timer(text)?.let { return it }
        SUN.find(text)?.let { return cmd("sun") }
        HELP.find(text)?.let { return cmd("help") } // a fixed, true answer: the small model invents skills
        DANCE.find(text)?.let { return cmd("dance") }
        MUTE.find(text)?.let { return cmd("mute") } // voice off: the page shows text only
        UNMUTE.find(text)?.let { return cmd("unmute") }
        METAL.find(text)?.let { return cmd("metal") }
        STOP.find(text)?.let { return cmd("stop") }
        play(text)?.let { return it }
        smalltalk(text)?.let { return cmd("smalltalk", JSONObject().put("kind", it)) }
        return null
    }

    // ---- Trams and buses: the offline timetable on the page (web/src/transit/). Rules only: Needle has no such tools.
    // "transit" plans a trip ({dest, mode}; dest "home" means the saved home), "next_departure" reads a stop's next
    // departures, "set_home" saves the current GPS fix as home (on the phone only). A plain "take me to X" without a
    // mode stays a walking route (navigate_to). ----

    /** tram / bus / any: what a spoken mode means. */
    /** Places the map finds by category (its search knows these words in English and German). */
    private const val AMENITY = "(toilets?|wc|bathroom|restroom|loo|pharmacy|chemist|cafe|café|coffee|supermarket|hospital|restaurant)"

    private const val MODE = "(trams?|bus|buses|busses|public transport|public transit|transit|the tram|the bus|tram or bus|bus or tram|the train|train|s bahn|the s bahn|öffis)"

    private val TRIP = listOf(
        // "how do I get home by tram", "how can we get to the hauptbahnhof by bus", "how do i go to postplatz with public transport"
        Regex("^how (?:do|can|should|would) (?:i|we) (?:get|go|travel|ride|reach)(?: to)? (.+?) (?:by|with|on|using|via|taking) $MODE$"),
        // "take me to hauptbahnhof by tram", "get us home by bus", "bring me home with public transport"
        Regex("^$CAN(?:take|get|bring) (?:me|us)(?: to)? (.+?) (?:by|with|on|using|via) $MODE$"),
        // "which tram goes to pirnaischer platz", "what bus can i take to the zoo", "which line goes home"
        Regex("^(?:which|what) (tram|bus|line|train)s? (?:goes|go|runs|run|drives|takes me|takes us|can i take|should i take|do i take|do i need)(?: to)? (.+)$"),
        // "tram to postplatz", "next bus home", "a tram home"
        Regex("^(?:the |a |next |the next )?(tram|bus) (?:to )?(.+)$"),
        // "can I take the tram to albertplatz", "is there a tram to the neustadt"
        Regex("^(?:can|could|should) (?:i|we) (?:take|get|catch) (?:a |the )?(tram|bus) to (.+)$|^is there (?:a |any )?(tram|bus) (?:to|going to) (.+)$"),
        // "what's the fastest way to the hauptbahnhof"
        Regex("^what(?:'s| is) the (?:fastest|quickest|best) way to (?:get to )?(.+)$"),
    )
    /** A trip slot that is really a question about it ("the tram to Prague, is that real"). */
    private val NOT_A_DEST = Regex("\\b(?:is|are|was|were|does|do|did|real|really)\\b")
    /** "Get me home", "take me home", "how do I get home": the trip home, any mode (walking alone cannot route "home"). */
    private val HOME_TRIP = Regex("^$CAN(?:get|take|bring) (?:me|us) (?:back )?home$|^how (?:do|can) (?:i|we) get (?:back )?home$")
    private val HOME_WORDS = setOf("home", "my home", "my place", "my house", "my flat", "my apartment", "back home", "home again")

    /** "When is the next tram to Postplatz", "the next bus home": a trip there (its first ride is the next one). */
    private val NEXT_TO = Regex(
        "^(?:(?:when(?:'s| is| does| will)?|what time(?: is| does| will)?) )?(?:the )?next (tram|bus|train|connection)" +
            "(?: leave| come| go| depart| run| that goes| that runs)?(?:(?: for| to| towards| going to| that goes to) (.+)| (home|back home))$",
    )

    private val NEXT_DEPARTURE = listOf(
        // "when is the next tram at postplatz", "what time does the next bus leave from the zoo", "when's the next tram from here"
        Regex(
            "^(?:when(?:'s| is| does| will)?|what time(?: is| does| will)?) (?:the )?next (tram|bus|train|departure|connection)" +
                "(?: leave| come| go| depart| arrive| get here| be here)?(?: (?:at|from) (.+))?$",
        ),
        // "next tram at postplatz", "next departures from hauptbahnhof", "departures at postplatz"
        Regex("^(?:the )?next (tram|bus|departures?)s? (?:at|from) (.+)$"),
        Regex("^(departures?)(?: board)? (?:at|from) (.+)$"),
    )
    private val SET_HOME = Regex(
        "^(?:this is (?:my )?home|this is where i live|i live here|my home is here|home is here|here is my home|" +
            "remember where i live|this is my (?:house|flat|apartment|place)|" +
            "(?:save|set|mark|remember|store|make) (?:this|here|this place|this spot|this location|where i am|where we are|my location|the current location)" +
            "(?: as| to be| to)? (?:my )?home(?: location)?|(?:save|set) (?:my )?home(?: here| to here| location)?)$",
    )

    private fun mode(raw: String) = when {
        raw.contains("tram") && raw.contains("bus") -> "any"
        raw.contains("tram") -> "tram"
        raw.contains("bus") -> "bus"
        else -> "any"
    }

    /** A destination as the page wants it: "the zoo" → "zoo", any of "my place", "home" … → "home". */
    private fun destination(raw: String): String {
        val d = raw.trim().removePrefix("get to ").removePrefix("get ").removePrefix("go to ").removePrefix("the ").trim()
        return if (d in HOME_WORDS) "home" else d
    }

    private fun trip(dest: String, mode: String): Command? {
        val d = destination(dest)
        if (d.isEmpty() || d.length > 60 || NOT_A_DEST.containsMatchIn(d)) return null
        val args = if (d == "home") JSONObject().put("dest", d) else placeArgs("dest", d)
        return cmd("transit", args.put("mode", mode))
    }

    /** A transit command for the normalised utterance (trip, next departure, set home), or null. */
    internal fun transit(text: String): Command? {
        if (text.length > 90) return null
        if (SET_HOME.matches(text)) return cmd("set_home")
        if (HOME_TRIP.matches(text)) return trip("home", "any")
        NEXT_TO.matchEntire(text)?.let { return trip(it.groupValues[2].ifEmpty { "home" }, mode(it.groupValues[1])) }
        for (r in NEXT_DEPARTURE) {
            val m = r.matchEntire(text) ?: continue
            val stop = m.groupValues[2].trim().removePrefix("the ").trim()
            val here = stop.isEmpty() || stop == "here"
            return cmd("next_departure", JSONObject().put("stop", if (here) "" else stop).put("mode", mode(m.groupValues[1])))
        }
        TRIP[0].matchEntire(text)?.let { return trip(it.groupValues[1], mode(it.groupValues[2])) }
        TRIP[1].matchEntire(text)?.let { return trip(it.groupValues[1], mode(it.groupValues[2])) }
        TRIP[2].matchEntire(text)?.let { return trip(it.groupValues[2], mode(it.groupValues[1])) }
        TRIP[3].matchEntire(text)?.let { m ->
            val dest = m.groupValues[2]
            // "tram to X" or "bus home"; a bare "bus stop" or "tram ride" is not a trip
            if (text.contains(" to ") || destination(dest) == "home") return trip(dest, mode(m.groupValues[1]))
        }
        TRIP[4].matchEntire(text)?.let { m ->
            val g = m.groupValues
            return if (g[1].isNotEmpty()) trip(g[2], mode(g[1])) else trip(g[4], mode(g[3]))
        }
        TRIP[5].matchEntire(text)?.let { return trip(it.groupValues[1], "any") }
        return null
    }

    // ---- Fun: jokes, fun facts, a song, a coin, dice, rock paper scissors, a number. The page picks the variant
    // or the random result (assistant.ts), so the same question never gets the same joke twice in a row. ----

    private val JOKE = Regex(
        "^$CAN(?:tell (?:me |us )?|say |give me |do you (?:know|have) |got |know )?(?:a |another |one more |any |some |a funny |a good |your best )?" +
            "(?:joke|jokes)(?: for me)?$|^(?:make me laugh|say something funny|tell me something funny|be funny|cheer me up with a joke)$",
    )
    private val FACT = Regex(
        "^$CAN(?:tell (?:me |us )?|give me |say |share |do you (?:know|have) |know )?(?:a |another |one more |some |any )?" +
            "(?:fun |random |cool |interesting |crazy |weird |amazing )?facts?(?: for me)?$|" +
            "^(?:tell me something (?:interesting|cool|new|fun|amazing|i don't know)|teach me something(?: new)?|did you know)$",
    )
    private val SONG = Regex("^$CAN(?:sing|hum)(?: me| us)?(?: a| another| your| a little| some| something| the)?(?: song| tune| little song| rhyme)?(?: for me)?$")
    private val COIN = Regex("^$CAN(?:flip|toss|throw|spin)(?: me)? (?:a |the |one )?coin(?: for me)?$|^(?:heads or tails|coin (?:flip|toss)|flip for it)$")
    private val DICE = Regex("^$CAN(?:roll|throw|toss)(?: me)? (?:a |the |one |some |(two|2|three|3) )?(?:dice|die|dices|six sided die)(?: for me)?$|^(?:dice roll|roll)$")
    private val RPS = Regex("^$CAN(?:play )?(?:a game of )?(?:rock paper scissors?|rock paper scissor)(?: with me)?(?: shoot)?$")
    private val NUMBER = Regex(
        "^$CAN(?:pick|choose|give me|think of|say|tell me)(?: me)? (?:a )?(?:random )?number(?: (?:between|from) (\\S+(?: \\S+)?) (?:and|to) (\\S+(?: \\S+)?))?$|^random number$",
    )

    /** The fun command for a whole short sentence ("tell me a joke" → fun {kind: joke}), or null. */
    internal fun play(text: String): Command? {
        if (text.length > 60) return null
        fun kind(k: String) = JSONObject().put("kind", k)
        return when {
            JOKE.matches(text) -> cmd("fun", kind("joke"))
            FACT.matches(text) -> cmd("fun", kind("fact"))
            SONG.matches(text) -> cmd("fun", kind("song"))
            COIN.matches(text) -> cmd("fun", kind("coin"))
            RPS.matches(text) -> cmd("fun", kind("rps"))
            else -> DICE.matchEntire(text)?.let { m ->
                val n = when (m.groupValues[1]) { "two", "2" -> 2; "three", "3" -> 3; else -> 1 }
                cmd("fun", kind("dice").put("count", n))
            } ?: NUMBER.matchEntire(text)?.let { m ->
                val lo = number(m.groupValues[1])?.toInt()
                val hi = number(m.groupValues[2])?.toInt()
                val (min, max) = if (lo != null && hi != null && lo != hi && minOf(lo, hi) >= 0 && maxOf(lo, hi) <= 1_000_000) minOf(lo, hi) to maxOf(lo, hi) else 1 to 10
                cmd("fun", kind("number").put("min", min).put("max", max))
            }
        }
    }

    // ---- Timer: one countdown, drawn round the screen edge by the page (timer.ts). Rules only for control phrases;
    // "set_timer" stays a Needle tool. Kept in its own block: other rules live above and below. ----

    private const val UNIT = "(seconds?|secs?|minutes?|mins?|hours?|hrs?)"

    /** "5 minutes", "1 and a half minutes", "a minute and a half", "2 minutes 30 seconds", "half an hour", "1.5 hours". */
    private val DURATION = Regex("^(.+?)( and a half)? $UNIT( and a half)?(?: (?:and )?(.+?) $UNIT)?$")

    private val TIMER_SET = listOf(
        // "set a timer for 5 minutes", "set a pasta timer for 8 minutes", "timer for the pasta 8 minutes"
        Regex("^(?:$CAN)?(?:set me |set up |set |start |make |put on )?(?:a |an |the |my )?(?:([a-z]+) )?(?:timer|alarm|countdown)(?: for| of| on)? (.+)$"),
        // "start a 10 minute timer", "an 8 minute timer for the pasta"
        Regex("^(?:$CAN)?(?:set |start |make )?(?:a |an )?(.+?) (?:timer|countdown|alarm)(?: for (?:the |my )?([a-z' ]+))?$"),
        // "wake me up in 2 hours", "remind me in 90 seconds"
        Regex("^(?:wake me|remind me|tell me|ping me)(?: up)? in (.+)$"),
        // "count down from one minute", "can you time five minutes"
        Regex("^(?:$CAN)?count ?down (?:from |for )?(.+)$|^(?:$CAN)?time (.+)$"),
    )

    /** Pomodoro: a quiet focus countdown (25 minutes unless said), Val sits still. */
    private val FOCUS = Regex(
        "^(?:$CAN)?(?:start |begin )?(?:a |the )?(?:pomodoro|focus mode|focus time|focus session|focus timer)(?: for (.+))?$|" +
            "^(?:help me |let me |let's |lets |i (?:want|need) to )(?:focus|concentrate)(?: for (.+))?$|^(?:focus|concentrate) for (.+)$",
    )
    private val TIMER_LEFT = Regex(
        "^(?:how (?:long|much time|much longer)(?: is| do i have| do we have| have i got)?(?: left| remaining| to go)(?: on (?:the|my) timer)?|" +
            "how much (?:time )?(?:is )?left(?: on (?:the|my) timer)?|(?:how much )?time left|what(?:'s| is) left on (?:the|my) timer|" +
            "(?:check|show me) (?:the|my) timer|when is (?:the|my) timer (?:up|done)|how(?:'s| is) (?:the|my) timer(?: doing)?)$",
    )
    private val TIMER_CANCEL = Regex(
        "^(?:$CAN)?(?:cancel|stop|end|kill|clear|delete|turn off|switch off|reset|forget)(?: the| my)? " +
            "(?:timer|alarm|countdown|focus(?: mode| time| session)?|pomodoro)$",
    )
    private val TIMER_ADD = Regex("^(?:$CAN)?(?:add|add on)(?: another| an extra| extra)? (.+?)(?: more)?(?: (?:to|on) (?:the|my) timer)?$|^(.+?) more $UNIT$")
    private val TIMER_PAUSE = Regex("^(?:$CAN)?(?:pause|hold|freeze)(?: the| my)? (?:timer|countdown)$")
    private val TIMER_RESUME = Regex("^(?:$CAN)?(?:resume|continue|unpause|restart|start)(?: the| my)? (?:timer|countdown)(?: again)?$")

    /** Words in front of "timer" that are not a label ("a new timer"). */
    private val NOT_LABELS = setOf("new", "quick", "another", "second", "short", "little", "set", "start", "make", "a", "an", "the", "my", "for")

    private fun unitSeconds(unit: String) = when (unit[0]) { 'h' -> 3600.0; 'm' -> 60.0; else -> 1.0 }

    private fun amount(words: String): Double? = when (words) {
        "half", "half a", "half an" -> 0.5
        else -> number(words)
    }

    /**
     * Needle's timer tool only has "minutes", so "set a timer for 30 seconds" can come back as 30 minutes. When the
     * picked command is a timer, the length is read again from the words themselves (seconds, minutes or hours).
     */
    fun fixTimer(cmd: Command, text: String): Command {
        if (cmd.name != "set_timer") return cmd
        val m = SPOKEN_LENGTH.find(text) ?: return cmd
        val (num, half, unit) = m.destructured
        val n = amount(num) ?: amount(num.substringAfterLast(' ')) ?: return cmd // "time thirty seconds": just "thirty"
        val halfAfter = text.startsWith(" and a half", m.range.last + 1) // "an hour and a half"
        val s = (n + if (half.isNotEmpty() || halfAfter) 0.5 else 0.0) * unitSeconds(unit)
        if (s <= 0) return cmd
        val args = JSONObject(cmd.args.toString()).put("minutes", s / 60.0)
        return Command(cmd.name, args, cmd.confidence)
    }
    private val SPOKEN_LENGTH = Regex("""(\d+(?:\.\d+)?|half an?|an?|[a-z]+(?:[ -][a-z]+)?)( and a half)? (seconds?|secs?|minutes?|mins?|hours?|hrs?)\b""")

    /** Seconds in a spoken duration, or null when it is not one. */
    internal fun seconds(phrase: String): Double? {
        val m = DURATION.matchEntire(phrase.trim()) ?: return null
        val g = m.groupValues
        val n = amount(g[1]) ?: return null
        val half = if (g[2].isNotEmpty() || g[4].isNotEmpty()) 0.5 else 0.0
        var s = (n + half) * unitSeconds(g[3])
        if (g[5].isNotEmpty()) s += (amount(g[5]) ?: return null) * unitSeconds(g[6])
        return s
    }

    /** A short label ("pasta") or null: at most 3 words, none of them a number. */
    private fun label(raw: String?): String? {
        val words = raw.orEmpty().split(' ').filter { it.isNotEmpty() && it !in NOT_LABELS }
        if (words.isEmpty() || words.size > 3 || words.any { number(it) != null }) return null
        return words.joinToString(" ")
    }

    /** The rest after "timer (for)": a duration, maybe with a label in front ("the pasta 8 minutes") or after ("8 minutes for the pasta"). */
    private fun labelled(rest: String): Pair<Double, String?>? {
        seconds(rest)?.let { return it to null }
        Regex("^(.+?) for (?:the |my )?([a-z' ]+)$").matchEntire(rest)?.let { m ->
            seconds(m.groupValues[1])?.let { s -> return s to label(m.groupValues[2]) }
        }
        val words = rest.split(' ')
        for (i in 1 until words.size) {
            val s = seconds(words.drop(i).joinToString(" ")) ?: continue
            val l = label(words.take(i).joinToString(" ")) ?: return null
            return s to l
        }
        return null
    }

    private fun setTimer(seconds: Double, label: String? = null, focus: Boolean = false): Command {
        val args = JSONObject().put("minutes", seconds / 60.0)
        if (label != null) args.put("label", label)
        if (focus) args.put("focus", true)
        return cmd("set_timer", args)
    }

    private fun timerOp(op: String, seconds: Double? = null): Command {
        val args = JSONObject().put("op", op)
        if (seconds != null) args.put("minutes", seconds / 60.0)
        return cmd("timer", args)
    }

    /** A timer command for the normalised utterance, or null. Control phrases first ("start the timer again" resumes). */
    internal fun timer(text: String): Command? {
        if (TIMER_LEFT.matches(text)) return timerOp("left")
        if (TIMER_CANCEL.matches(text)) return timerOp("cancel")
        if (TIMER_PAUSE.matches(text)) return timerOp("pause")
        if (TIMER_RESUME.matches(text)) return timerOp("resume")
        TIMER_ADD.matchEntire(text)?.let { m ->
            val g = m.groupValues
            val s = if (g[1].isNotEmpty()) seconds(g[1].replace(Regex("\\bmore "), "")) else seconds("${g[2]} ${g[3]}") // "one more minute"
            if (s != null) return timerOp("add", s)
        }
        FOCUS.matchEntire(text)?.let { m ->
            val said = m.groupValues.drop(1).firstOrNull { it.isNotEmpty() }
            val s = if (said == null) 25 * 60.0 else seconds(said) ?: return null
            return setTimer(s, focus = true)
        }
        TIMER_SET[0].matchEntire(text)?.let { m ->
            val (s, l) = labelled(m.groupValues[2]) ?: return@let
            return setTimer(s, l ?: label(m.groupValues[1]))
        }
        TIMER_SET[1].matchEntire(text)?.let { m ->
            val s = seconds(m.groupValues[1]) ?: return@let
            return setTimer(s, label(m.groupValues[2]))
        }
        TIMER_SET[2].matchEntire(text)?.let { m -> seconds(m.groupValues[1])?.let { return setTimer(it) } }
        TIMER_SET[3].matchEntire(text)?.let { m -> seconds(m.groupValues.drop(1).first { it.isNotEmpty() })?.let { return setTimer(it) } }
        return null
    }

    // ---- Small talk: fixed, warm replies from Val (assistant.ts picks the words); whole short sentences only ----

    /** Small-talk kinds and the whole normalised sentences that mean them, checked in this order. */
    private val SMALLTALK: List<Pair<String, Regex>> = listOf(
        "greet" to Regex(
            "^(?:hi|hiya|hello|hallo|hey|heya|howdy|yo|there|val|vel|greetings|moin|hey there|hi there|hello there|" +
                "(?:good )?(?:morning|afternoon|evening)|good day|guten (?:morgen|tag|abend))$",
        ),
        "how_about_you" to Regex("^(?:and )?(?:how about you|what about you|and you|and yourself|how about yourself)$"),
        "how_are_you" to Regex(
            "^(?:and )?(?:how (?:are|r) (?:you|ya|u)|how're you|how you)(?: doing| feeling)?(?: today| now| tonight| this morning)?$|" +
                "^(?:how(?:'s| is) it going|how(?:'s| are) things|how have you been|how(?:'s| is) your day(?: going)?|" +
                "what's up|whats up|sup|how do you feel|are you (?:okay|ok|good|alright|doing well)|you okay)$",
        ),
        "name" to Regex(
            "^(?:what(?:'s| is) your name(?: again)?|who are you|what are you|who am i talking to|who is this|" +
                "what (?:do|should) i call you|what are you called|do you have a name|tell me your name|introduce yourself)$",
        ),
        "thanks" to Regex("^(?:thanks?|thank you|thanks a lot|many thanks|cheers|danke(?: schön| schoen)?|much appreciated)(?: so much| very much| a lot)?$"),
        "night" to Regex("^(?:good ?night|night|night night|nighty night|sleep well|sweet dreams|gute nacht|i(?:'m| am) going to (?:bed|sleep))$"),
        "bye" to Regex(
            "^(?:bye|bye bye|goodbye|good bye|see you(?: later| soon| tomorrow)?|see ya|catch you later|gotta go|" +
                "i (?:have|got) to go|i(?:'m| am) (?:leaving|off)|tschüss|tschüs|ciao|farewell)$",
        ),
        "love" to Regex(
            "^(?:i love you(?: so much| too)?|love you|i like you|i adore you|you(?:'re| are) my (?:best )?friend|good (?:robot|job)|" +
                "you(?:'re| are) (?:so |really |very )?(?:cute|adorable|sweet|lovely|awesome|amazing|the best|funny|cool)|" +
                "(?:you )?(?:look|looking) (?:so |really |very )?(?:cute|adorable|lovely|great|sweet)(?: today)?)$",
        ),
        "real" to Regex(
            "^(?:are you (?:real|alive|a real robot|a robot|human|a human|a person|a real person|conscious|sentient|an ai)|" +
                "do you have (?:feelings|a heart|a soul)|can you feel)$",
        ),
        "home" to Regex("^(?:where (?:are you from|do you (?:live|come from)|are you)|where(?:'s| is) your home)$"),
        "age" to Regex("^(?:how old are you|what(?:'s| is) your age|when (?:were you|is your) (?:born|made|built|birthday)|what(?:'s| is) your birthday)$"),
    )

    /** The small-talk kind for a short, whole sentence ("how are you" → "how_are_you"), or null. */
    internal fun smalltalk(text: String): String? {
        if (text.length > 40) return null
        return SMALLTALK.firstOrNull { it.second.matches(text) }?.first
    }

    /** True when a picked command should be acted out; otherwise the utterance goes to the chat model. */
    fun acts(c: Command): Boolean = c.name in ACTIONS && c.confidence >= ACTION_MIN_CONFIDENCE
}
