package io.github.haardhikk.charm

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RouterTest {

    private fun route(said: String) = Router.rule(Router.normalize(said))

    private fun assertRoute(said: String, name: String, arg: Pair<String, Any>? = null) {
        val c = route(said)
        assertEquals("\"$said\"", name, c?.name)
        if (arg != null) assertEquals("\"$said\"", arg.second, c!!.args.get(arg.first))
    }

    @Test
    fun normaliseDropsFillersWakeWordsAndPunctuation() {
        assertEquals("dance", Router.normalize("Hey Charm, um, dance please!"))
        assertEquals("what's this", Router.normalize("Okay so… what’s THIS?"))
        assertEquals("take a photo", Router.normalize("  uh take a photo now, thanks "))
        assertEquals("hello", Router.normalize("Hello!")) // a bare greeting stays (small talk answers it)
        assertEquals("dance", Router.normalize("Hey Val, dance!"))
        assertEquals("how are you", Router.normalize("Hey Vel, how are you?"))
        assertEquals("how are you", Router.normalize("hey al how are you"))
        assertEquals("val", Router.normalize("Hi Hal!"))
        assertEquals("thank you", Router.normalize("Thank you, Val."))
        assertEquals("", Router.normalize("um... uh?"))
    }

    @Test
    fun obviousPhrasesPickTheirCommand() {
        assertRoute("What is this?", "describe_photo")
        assertRoute("What's that thing?", "describe_photo")
        assertRoute("Hey Charm, what am I looking at?", "describe_photo")
        assertRoute("Can you see this?", "describe_photo")
        assertRoute("Take a picture.", "take_photo")
        assertRoute("Could you snap a photo of me please", "take_photo")
        assertRoute("take a selfie", "take_photo")
        assertRoute("Where am I?", "place") // spoken from the senses (SensesTest); the map is "show me where I am"
        assertRoute("I'm lost.", "where_am_i")
        assertRoute("Show me where I am", "where_am_i")
        assertRoute("Take me to the Frauenkirche.", "navigate_to", "place" to "frauenkirche")
        assertRoute("Navigate to Zwinger", "navigate_to", "place" to "zwinger")
        assertRoute("How do I get to the main station?", "navigate_to", "place" to "hauptbahnhof")
        assertRoute("Directions to Neumarkt please", "navigate_to", "place" to "neumarkt")
        assertRoute("Remember my locker is 42.", "remember_note", "text" to "my locker is 42")
        assertRoute("Remember that I parked on level 3", "remember_note", "text" to "i parked on level 3")
        assertRoute("Don't forget the keys are in the blue bag", "remember_note", "text" to "the keys are in the blue bag")
        assertRoute("Where is my locker?", "recall_note", "topic" to "locker")
        assertRoute("What's my locker number?", "recall_note", "topic" to "locker number")
        assertRoute("Where did I park my car?", "recall_note", "topic" to "car")
        assertRoute("Do you remember my locker?", "recall_note", "topic" to "locker")
        assertRoute("Remember this", "remember_photo")
        assertRoute("Val, remember what you saw", "remember_photo")
        assertRoute("can you remember this photo please", "remember_photo")
        assertRoute("save that picture", "remember_photo")
        assertRoute("remember this is my bike", "remember_note", "text" to "this is my bike")
        assertTrue("remember_photo" in Router.ACTIONS)
        assertRoute("Dance!", "dance")
        assertRoute("Can you do a little dance?", "dance")
        assertRoute("Hey Charm, let's dance", "dance")
    }

    // ---- Timer (timer.ts on the page): its own block ----

    private fun assertTimer(said: String, minutes: Double, label: String? = null, focus: Boolean = false) {
        val c = route(said)
        assertEquals("\"$said\"", "set_timer", c?.name)
        assertEquals("\"$said\"", minutes, c!!.args.getDouble("minutes"), 1e-9)
        assertEquals("\"$said\" label", label, c.args.optString("label").ifEmpty { null })
        assertEquals("\"$said\" focus", focus, c.args.optBoolean("focus"))
    }

    private fun assertTimerOp(said: String, op: String, minutes: Double? = null) {
        val c = route(said)
        assertEquals("\"$said\"", "timer", c?.name)
        assertEquals("\"$said\"", op, c!!.args.getString("op"))
        if (minutes != null) assertEquals("\"$said\"", minutes, c.args.getDouble("minutes"), 1e-9)
    }

    @Test
    fun spokenDurationsBecomeSeconds() {
        assertEquals(300.0, Router.seconds("5 minutes")!!, 0.0)
        assertEquals(300.0, Router.seconds("five minutes")!!, 0.0)
        assertEquals(1500.0, Router.seconds("twenty five minutes")!!, 0.0)
        assertEquals(90.0, Router.seconds("90 seconds")!!, 0.0)
        assertEquals(90.0, Router.seconds("1 and a half minutes")!!, 0.0)
        assertEquals(90.0, Router.seconds("one and a half minutes")!!, 0.0)
        assertEquals(90.0, Router.seconds("a minute and a half")!!, 0.0)
        assertEquals(150.0, Router.seconds("2 minutes 30 seconds")!!, 0.0)
        assertEquals(150.0, Router.seconds("two minutes and thirty seconds")!!, 0.0)
        assertEquals(1800.0, Router.seconds("half an hour")!!, 0.0)
        assertEquals(5400.0, Router.seconds("an hour and a half")!!, 0.0)
        assertEquals(5400.0, Router.seconds("1.5 hours")!!, 0.0)
        assertEquals(120.0, Router.seconds("a couple of minutes")!!, 0.0)
        assertNull(Router.seconds("the pasta"))
        assertNull(Router.seconds("lots of minutes"))
    }

    @Test
    fun timersAreSetWithLengthsLabelsAndFocus() {
        assertTimer("Set a timer for 5 minutes.", 5.0)
        assertTimer("Set a timer for one minute", 1.0)
        assertTimer("timer for twenty five minutes", 25.0)
        assertTimer("Start a 10 minute timer", 10.0)
        assertTimer("Set a timer for half an hour", 30.0)
        assertTimer("Wake me up in 2 hours", 120.0)
        assertTimer("Set a timer for 30 seconds", 0.5)
        assertTimer("Set a timer for 90 seconds", 1.5)
        assertTimer("Set a timer for 1 and a half minutes", 1.5)
        assertTimer("Set a timer for 1.5 minutes", 1.5)
        assertTimer("Hey Val, set a timer for five minutes please", 5.0)
        assertTimer("Timer for the pasta, 8 minutes", 8.0, "pasta")
        assertTimer("Set a pasta timer for 8 minutes", 8.0, "pasta")
        assertTimer("Set a timer for 8 minutes for the pasta", 8.0, "pasta")
        assertTimer("An 8 minute timer for the eggs", 8.0, "eggs")
        assertTimer("Remind me in 90 seconds", 1.5)
        assertTimer("Start a pomodoro", 25.0, focus = true)
        assertTimer("Focus mode", 25.0, focus = true)
        assertTimer("Help me focus for 10 minutes", 10.0, focus = true)
        assertTimer("Let's focus", 25.0, focus = true)
        assertTrue("timer" in Router.ACTIONS)
    }

    @Test
    fun theRunningTimerIsControlledByWords() {
        assertTimerOp("How long left?", "left")
        assertTimerOp("How much time is left?", "left")
        assertTimerOp("How much time do I have left", "left")
        assertTimerOp("What's left on the timer?", "left")
        assertTimerOp("Cancel the timer", "cancel")
        assertTimerOp("Stop the timer.", "cancel")
        assertTimerOp("Stop focus mode", "cancel")
        // Heard on the phone in a loud hall, all meaning "cancel the timer".
        assertTimerOp("Council timer.", "cancel")
        assertTimerOp("Timur Gansen.", "cancel")
        assertTimerOp("Cancelled a timer", "cancel")
        assertTimerOp("Stop the Timur", "cancel")
        assertTimerOp("Timer off", "cancel")
        assertTimerOp("Can you council the timer", "cancel")
        assertEquals("council meeting", Router.normalize("Council meeting"))
        assertEquals("who is timur", Router.normalize("Who is Timur?"))
        assertTimerOp("Add a minute", "add", 1.0)
        assertTimerOp("Add 30 seconds to the timer", "add", 0.5)
        assertTimerOp("Five more minutes", "add", 5.0)
        assertTimerOp("Pause the timer", "pause")
        assertTimerOp("Resume the timer", "resume")
        assertTimerOp("Start the timer again", "resume")
        // Neighbours keep their meaning.
        assertRoute("How long until sunset?", "sun")
        assertRoute("Stop", "stop")
    }

    @Test
    fun voiceModeIsSwitchedByWords() {
        assertRoute("Be quiet", "mute")
        assertRoute("Mute.", "mute")
        assertRoute("Hey Charm, stop talking please", "mute")
        assertRoute("Can you be quiet now?", "mute")
        assertRoute("Talk to me", "unmute")
        assertRoute("Unmute!", "unmute")
        assertRoute("Voice on", "unmute")
        assertNull(route("Stop talking about the weather"))
        assertNull(route("Talk to me about the Zwinger"))
        assertTrue(Router.acts(Command("mute", JSONObject(), 1.0)))
        assertTrue(Router.acts(Command("unmute", JSONObject(), 1.0)))
    }

    @Test
    fun questionsAndMessyTranscriptsGoToNeedleOrChat() {
        for (said in listOf(
            "Hello, how are you? I'm going to talk about the weather in Dresden.",
            "How old is the Frauenkirche?",
            "What is the Zwinger?",
            "Tell me a joke about the Frauenkirche and the Zwinger", // a long ask: the chat model
            "I went to a dance class yesterday and it was fun",
            "What is this city famous for?",
            "Set a timer", // no length: Needle decides
            "Give me a minute", // not "add a minute"
            "Why is the sky blue?",
            "",
            "um",
        )) assertNull("\"$said\"", route(said))
    }

    @Test
    fun funPhrasesBecomePageActions() {
        for ((said, kind) in listOf(
            "tell me a joke" to "joke", "Hey Val, tell me another joke!" to "joke", "do you know any jokes" to "joke", "make me laugh" to "joke",
            "joke please" to "joke", "tell me a fun fact" to "fact", "give me a random fact" to "fact", "tell me something interesting" to "fact",
            "sing a song" to "song", "can you sing me a song" to "song", "sing" to "song", "flip a coin" to "coin", "heads or tails" to "coin",
            "toss a coin for me" to "coin", "roll a dice" to "dice", "roll the die" to "dice", "rock, paper, scissors!" to "rps",
            "let's play rock paper scissors" to "rps", "pick a number" to "number", "pick a random number" to "number",
        )) assertRoute(said, "fun", "kind" to kind)
        assertRoute("roll two dice", "fun", "count" to 2)
        val n = route("pick a number between 1 and 100")!!
        assertEquals(1, n.args.getInt("min"))
        assertEquals(100, n.args.getInt("max"))
        val w = route("choose a number from twenty to five")!!
        assertEquals(5 to 20, w.args.getInt("min") to w.args.getInt("max"))
        val d = route("pick a number")!!
        assertEquals(1 to 10, d.args.getInt("min") to d.args.getInt("max"))
        assertTrue(Router.acts(route("flip a coin")!!))
        for (said in listOf("tell me a joke about my friend from school who likes trains", "is that a fact", "the coin is on the table", "dice are fun")) {
            assertTrue("\"$said\"", route(said)?.name != "fun")
        }
    }

    @Test
    fun aVeryLongTranscriptNeverMatchesARule() {
        assertNull(route("dance " + "and ".repeat(60) + "dance"))
    }

    @Test
    fun onlyConfidentActionsAreActedOut() {
        fun c(name: String, conf: Double) = Command(name, JSONObject(), conf)
        assertTrue(Router.acts(c("dance", Router.ACTION_MIN_CONFIDENCE)))
        assertTrue(Router.acts(c("navigate_to", 0.95)))
        assertFalse(Router.acts(c("navigate_to", 0.7)))
        assertFalse(Router.acts(c("take_photo", 0.45))) // seen on the phone for "how tall is the frauenkirche"
        assertFalse(Router.acts(c("dance", Router.ACTION_MIN_CONFIDENCE - 0.01)))
        assertFalse(Router.acts(c("answer_question", 0.9))) // questions always go to the chat model
        assertFalse(Router.acts(c("none", 1.0)))
        assertFalse(Router.acts(c("launch_rocket", 1.0)))
        assertEquals(0.9, Router.ACTION_MIN_CONFIDENCE, 0.0)
    }

    @Test
    fun numberWords() {
        assertEquals(7.0, Router.number("seven")!!, 0.0)
        assertEquals(45.0, Router.number("forty five")!!, 0.0)
        assertEquals(1.5, Router.number("1.5")!!, 0.0)
        assertNull(Router.number("many"))
    }

    @Test
    fun sunAndMoonQuestionsShowTheSunCard() {
        for (said in listOf(
            "When is sunset?",
            "Hey Charm, when does the sun set?",
            "When does the sun rise tomorrow?",
            "When's sunrise",
            "What time is sunset today?",
            "How long until dark?",
            "How long till it gets dark?",
            "What's the moon phase?",
            "Moon phase",
            "What phase is the moon in tonight?",
            "How full is the moon tonight",
        )) assertRoute(said, "sun")
        assertTrue(Router.acts(Command("sun", JSONObject(), 1.0)))
    }

    @Test
    fun metalDetectorPhrasesStartTheMode() {
        for (said in listOf(
            "Find metal",
            "Hey Val, metal detector!",
            "Detect metal",
            "Look for magnets",
            "Can you find some metal for me?",
            "Turn on the metal detector",
            "Look for a magnet",
            // Heard on the phone in a loud room.
            "Fine metal.",
            "This is a fine matter.",
            "Make it to find metal.",
            "I think that this is fine metal.",
        )) assertRoute(said, "metal")
        assertTrue(Router.acts(Command("metal", JSONObject(), 1.0)))
        for (said in listOf("Don't find metal", "Turn off find metal", "No, I don't want to find metal")) {
            assertTrue(said, Router.normalize(said) != "find metal")
        }
    }

    @Test
    fun stopEndsTheMode() {
        for (said in listOf("Stop!", "Okay stop", "Stop it, Val", "That's enough", "Turn off the metal detector")) assertRoute(said, "stop")
        assertTrue(Router.acts(Command("stop", JSONObject(), 1.0)))
        assertEquals("mute", route("stop talking")?.name) // still the voice switch
        for (said in listOf("What is metal made of?", "Why do magnets stick to the fridge?", "Stop the war")) assertNull("\"$said\"", route(said))
    }

    @Test
    fun otherSunAndMoonTalkStillGoesToChat() {
        for (said in listOf("Why is the sun hot?", "What is the moon made of?", "Tell me about sunsets in Dresden")) {
            assertNull("\"$said\"", route(said))
        }
    }

    @Test
    fun helpGetsTheFixedAnswer() {
        assertEquals("help", Router.rule(Router.normalize("Hey Charm, what can you do?"))?.name)
    }

    // ---- Small talk (Val's fixed replies) ----

    @Test
    fun smallTalkPicksItsKind() {
        for ((said, kind) in listOf(
            "Hello!" to "greet",
            "Hi" to "greet",
            "Hey Val!" to "greet",
            "Hi there." to "greet",
            "Good morning, Val" to "greet",
            "good evening" to "greet",
            "Hi Hal" to "greet",
            "Hello, how are you?" to "how_are_you",
            "how are you doing today" to "how_are_you",
            "Hey Vel, how's it going?" to "how_are_you",
            "Um, how are you feeling?" to "how_are_you",
            "What's up?" to "how_are_you",
            "Are you okay?" to "how_are_you",
            "How about you?" to "how_about_you",
            "And you?" to "how_about_you",
            "What's your name?" to "name",
            "Who are you?" to "name",
            "What should I call you" to "name",
            "Thank you!" to "thanks",
            "Thanks so much, Val." to "thanks",
            "thank you very much" to "thanks",
            "Danke schön" to "thanks",
            "Good night!" to "night",
            "goodnight val" to "night",
            "Sweet dreams" to "night",
            "Bye!" to "bye",
            "Okay, bye bye" to "bye",
            "See you later!" to "bye",
            "I love you." to "love",
            "You're so cute!" to "love",
            "you are the best" to "love",
            "Are you real?" to "real",
            "Are you alive?" to "real",
            "Do you have feelings?" to "real",
            "Where are you from?" to "home",
            "Where do you live?" to "home",
            "How old are you?" to "age",
            "When were you born?" to "age",
        )) assertRoute(said, "smalltalk", "kind" to kind)
    }

    @Test
    fun smallTalkNeedsAShortWholeSentence() {
        for (said in listOf(
            "Hello, how are you? I'm going to talk about the weather in Dresden.",
            "How old is the Frauenkirche?",
            "How are the trams in Dresden?",
            "Thanks for the photo, what is in it again?",
            "I love you but can you tell me about the Zwinger",
            "Where are the toilets?",
            "Who are you voting for in the election?",
            "How old are the Zwinger gardens?",
            "you",
            "Al",
            "Well",
            "Is the bridge real?",
        )) {
            val c = route(said)
            assertTrue("\"$said\" -> ${c?.name}", c == null || c.name != "smalltalk")
        }
    }

    @Test
    fun senseQuestionsAreAnsweredFromThePhone() {
        assertRoute("What time is it?", "clock", "ask" to "time")
        assertRoute("Hey Val, what time is it now?", "clock", "ask" to "time")
        assertRoute("Do you know the time?", "clock", "ask" to "time")
        assertRoute("What day is it today?", "clock", "ask" to "day")
        assertRoute("Is it the weekend?", "clock", "ask" to "day")
        assertRoute("What's the date?", "clock", "ask" to "date")
        assertRoute("What is today's date?", "clock", "ask" to "date")
        assertRoute("How much battery do you have?", "battery", "ask" to "level")
        assertRoute("What's your battery level?", "battery", "ask" to "level")
        assertRoute("Are you charging?", "battery", "ask" to "charging")
        assertRoute("Are you plugged in?", "battery", "ask" to "charging")
        assertRoute("Where are we?", "place")
        assertRoute("Where am I right now?", "place")
        assertRoute("What's around here?", "place")
        assertRoute("How many satellites can you see?", "sky")
        assertRoute("Can you see the sky?", "sky")
        assertRoute("Do you have GPS?", "sky")
        assertRoute("How high are we?", "altitude")
        assertRoute("What's our altitude?", "altitude")
        assertRoute("How fast are we walking?", "speed")
        assertRoute("What's my speed?", "speed") // never a note lookup ("what's my …")
        assertRoute("Is it dark outside?", "dark")
        assertRoute("Is it night yet?", "dark")
        assertRoute("Has the sun set?", "dark")
        assertRoute("How long have you been awake?", "awake")
        // The map, notes and the sun card keep their phrases.
        assertRoute("Show me the map", "where_am_i")
        assertRoute("What's my locker number?", "recall_note")
        assertRoute("When is sunset?", "sun")
        assertRoute("How long until dark?", "sun")
        // Every senses command is one the app acts on.
        for (c in SenseFormat.COMMANDS) assertTrue(c, Router.acts(Command(c, JSONObject(), 1.0)))
    }

    @Test
    fun senseRulesNeedTheWholeSentence() {
        for (said in listOf("what time is it in New York", "how much battery does a tesla have", "where are we going for dinner", "is it dark in winter in norway")) {
            val c = route(said)
            assertTrue("\"$said\" -> ${c?.name}", c == null || c.name !in SenseFormat.COMMANDS)
        }
    }

    @Test
    fun capabilitiesAreStillTheHelpRule() {
        assertEquals("help", route("Hey Val, what can you do?")?.name)
    }

    @Test
    fun lookAtTheSkyIsItsOwnCommand() {
        for (said in listOf("Look at the sky", "Hey Val, look up!", "Can you look up at the stars?", "Look up at the sky please", "Let's look at the clouds", "Look into the sky")) {
            assertRoute(said, "look_up")
        }
        assertTrue(Router.acts(Command("look_up", JSONObject(), 1.0)))
        // Neighbours keep their own routes.
        assertRoute("Look at this", "describe_photo")
        assertRoute("Can you see the sky?", "sky")
        assertNull(route("Look up the opening hours of the Zwinger")?.takeIf { it.name == "look_up" })
    }

    @Test
    fun shortTimeAndDayQuestionsAlwaysHitTheClock() {
        for (q in listOf("what's the day today", "hey val what's the day today", "what time is it now", "tell me the date please", "is my battery low")) {
            val c = Router.rule(Router.normalize(q))
            assertTrue("$q -> ${c?.name}", c?.name == "clock" || (q.contains("battery") && c?.name == "battery"))
        }
        assertEquals("set_timer", Router.rule(Router.normalize("set a timer for 30 seconds"))?.name)
        assertNull(Router.looseSense("what happened on this day in history in dresden long ago"))
    }

    @Test
    fun rightNowAtTheEndIsDropped() {
        assertEquals("describe_photo", Router.rule(Router.normalize("what's in front of me right now"))?.name)
    }

    @Test
    fun aTimerFromTheModelTakesItsLengthFromTheWords() {
        fun needle(min: Double) = Command("set_timer", JSONObject().put("minutes", min), 0.95)
        assertEquals(0.5, Router.fixTimer(needle(30.0), "put a timer on for 30 seconds").args.getDouble("minutes"), 1e-9)
        assertEquals(0.5, Router.fixTimer(needle(30.0), "could you time thirty seconds for me").args.getDouble("minutes"), 1e-9)
        assertEquals(90.0, Router.fixTimer(needle(1.0), "alarm in an hour and a half").args.getDouble("minutes"), 1e-9)
        assertEquals(5.0, Router.fixTimer(needle(5.0), "remind me in five minutes").args.getDouble("minutes"), 1e-9)
        assertEquals(7.0, Router.fixTimer(needle(7.0), "a timer please").args.getDouble("minutes"), 1e-9) // no length said: keep
    }

    @Test
    fun heardHeyAsHeStillSetsTheTimer() {
        // Whisper base on the reference phone: "He set a timer for 30 seconds."
        val c = Router.rule(Router.normalize("He set a timer for 30 seconds."))
        assertEquals("set_timer", c?.name)
        assertEquals(0.5, c!!.args.getDouble("minutes"), 1e-9)
    }

    private fun assertTrip(said: String, dest: String, mode: String) {
        val c = route(said)
        assertEquals("\"$said\"", "transit", c?.name)
        assertEquals("\"$said\" dest", dest, c!!.args.getString("dest"))
        assertEquals("\"$said\" mode", mode, c.args.getString("mode"))
    }

    private fun assertDeparture(said: String, stop: String, mode: String) {
        val c = route(said)
        assertEquals("\"$said\"", "next_departure", c?.name)
        assertEquals("\"$said\" stop", stop, c!!.args.getString("stop"))
        assertEquals("\"$said\" mode", mode, c.args.getString("mode"))
    }

    @Test
    fun tripsByTramAndBusPlanTransit() {
        assertTrip("How do I get home by tram?", "home", "tram")
        assertTrip("How do I get home by bus?", "home", "bus")
        assertTrip("How do I get home by public transport?", "home", "any")
        assertTrip("Hey Val, how can we get back home with the tram", "home", "tram")
        assertTrip("Take me to Hauptbahnhof by tram.", "hauptbahnhof", "tram")
        assertTrip("Take me to the Hauptbahnhof by tram please", "hauptbahnhof", "tram")
        assertTrip("Can you get me to Postplatz by bus?", "postplatz", "bus")
        assertTrip("Which tram goes to Pirnaischer Platz?", "pirnaischer platz", "tram")
        assertTrip("What bus goes to the zoo?", "zoo", "bus")
        assertTrip("Which line goes to Albertplatz", "albertplatz", "any")
        assertTrip("What bus do I need to get home", "home", "bus")
        assertTrip("How do I get to Neustadt by bus?", "neustadt", "bus")
        assertTrip("How do I get to the Frauenkirche using public transport", "frauenkirche", "any")
        assertTrip("Get me home.", "home", "any")
        assertTrip("Take me home", "home", "any")
        assertTrip("How do I get home?", "home", "any")
        assertTrip("bring me to my place by tram", "home", "tram")
        assertTrip("Tram to Postplatz", "postplatz", "tram")
        assertTrip("next bus home", "home", "bus")
        assertTrip("When is the next tram to Postplatz?", "postplatz", "tram")
        assertTrip("When's the next bus to the zoo", "zoo", "bus")
        assertTrip("Next bus to Hauptbahnhof", "hauptbahnhof", "bus")
        assertTrip("the next tram to Pirnaischer Platz", "pirnaischer platz", "tram")
        assertTrip("What time does the next tram leave for Albertplatz?", "albertplatz", "tram")
        assertTrip("when is the next bus home", "home", "bus")
    }

    @Test
    fun nextDeparturesReadAStop() {
        assertDeparture("When is the next tram at Postplatz?", "postplatz", "tram")
        assertDeparture("When's the next bus from the Hauptbahnhof", "hauptbahnhof", "bus")
        assertDeparture("What time does the next tram leave from Albertplatz?", "albertplatz", "tram")
        assertDeparture("Next bus from Zoo", "zoo", "bus")
        assertDeparture("Next departures at Postplatz", "postplatz", "any")
        assertDeparture("Departures from Pirnaischer Platz", "pirnaischer platz", "any")
        assertDeparture("When is the next tram?", "", "tram") // the page asks which stop
        assertDeparture("when is the next tram from here", "", "tram")
    }

    @Test
    fun homeIsSavedFromWhereWeAre() {
        for (said in listOf(
            "This is my home.",
            "This is home",
            "Save this as home",
            "Save this as my home, Val",
            "Remember where I live",
            "Set this location as my home",
            "I live here",
            "Mark this place as home",
            "set home here",
        )) assertRoute(said, "set_home")
    }

    @Test
    fun transitRulesLeaveOtherPhrasesAlone() {
        assertRoute("Take me to the Frauenkirche.", "navigate_to", "place" to "frauenkirche") // no mode: walking
        assertRoute("How do I get to the main station?", "navigate_to", "place" to "hauptbahnhof")
        assertRoute("Remember my locker is 42.", "remember_note", "text" to "my locker is 42")
        assertRoute("Where is my home?", "recall_note", "topic" to "home")
        assertRoute("What time is it?", "clock", "ask" to "time")
        for (said in listOf(
            "How are the trams in Dresden?",
            "Is the bus stop far?",
            "I like the tram",
            "What is a tram?",
            "Tram ride",
            "This is my home planet",
            "Why are buses yellow?",
            "the bus driver was nice",
        )) {
            val c = route(said)
            assertTrue("\"$said\" -> ${c?.name}", c == null || c.name !in setOf("transit", "next_departure", "set_home"))
        }
        assertTrue(Router.acts(Command("transit", JSONObject(), 1.0)))
        assertTrue(Router.acts(Command("next_departure", JSONObject(), 1.0)))
        assertTrue(Router.acts(Command("set_home", JSONObject(), 1.0)))
    }

    @Test
    fun misheardPlacesAreRepairedInTheirSlot() {
        assertRoute("take me to the swinger", "navigate_to", "place" to "zwinger")
        assertRoute("Take me to the Semper Opera.", "navigate_to", "place" to "semperoper")
        assertRoute("take me to the noi shtat", "navigate_to", "place" to "neustadt")
        assertRoute("Which tram do I take to the main station?", "transit", "dest" to "hauptbahnhof")
        val unsure = route("Take me to the dredged in half-benef.")!!
        assertEquals("hauptbahnhof", unsure.args.getString("place"))
        assertEquals(true, unsure.args.getBoolean("confirm"))
        assertEquals("dredged in half benef", unsure.args.getString("heard"))
        // A sure name carries no confirm; an unknown one goes to the map search as heard.
        assertFalse(route("Take me to the Zwinger")!!.args.has("confirm"))
        assertRoute("Take me to Kaufland", "navigate_to", "place" to "kaufland")
        assertRoute("how do i get to the frauenkirche from here", "navigate_to", "place" to "frauenkirche")
    }

    @Test
    fun howFarWhichWayAndWhereIsNeedAKnownPlace() {
        assertRoute("How far is the Zwinger?", "navigate_to", "place" to "zwinger")
        assertRoute("How far away is the Frauenkirche from here?", "navigate_to", "place" to "frauenkirche")
        assertRoute("Which way is the Zwinger?", "navigate_to", "place" to "zwinger")
        assertRoute("Where is the Frauenkirche?", "navigate_to", "place" to "frauenkirche")
        assertNull(route("How far is the moon?"))
        assertNull(route("Where is the remote?"))
        assertRoute("Where is my locker?", "recall_note", "topic" to "locker")
    }

    @Test
    fun moreWaysToAskForDirections() {
        for (said in listOf("I want to go to the Frauenkirche.", "Let's go to the Frauenkirche.", "Get me to the Frauenkirche.", "Navigate me to the Frauenkirche.")) {
            assertRoute(said, "navigate_to", "place" to "frauenkirche")
        }
        assertRoute("Where is the nearest toilet?", "navigate_to", "place" to "toilet")
        assertRoute("Find a cafe nearby.", "navigate_to", "place" to "cafe")
        assertRoute("I need a pharmacy.", "navigate_to", "place" to "pharmacy")
        assertRoute("closest supermarket", "navigate_to", "place" to "supermarket")
        assertRoute("Is there a tram to the Neustadt?", "transit", "dest" to "neustadt")
        assertNull(route("The tram to Prague, is that real?"))
    }

    @Test
    fun looseClockQuestionsUseOnlyClockWords() {
        assertRoute("time please", "clock", "ask" to "time")
        assertRoute("Watch the time right now.", "clock", "ask" to "time")
        assertRoute("What's my time?", "clock", "ask" to "time")
        for (said in listOf("What time does the Zwinger open?", "What day is the party?", "What's the date of the Dresden bombing?")) {
            val c = route(said)
            assertTrue("\"$said\" -> ${c?.name}", c == null || c.name != "clock")
        }
        assertRoute("How much charge do you have left?", "battery")
    }

    @Test
    fun cameraAndMapPhrases() {
        for (said in listOf(
            "Describe this.", "Describe what you see.", "Do you know what this is?", "What does this say?", "Can you read this?",
            "What kind of plant is this?", "What colour is this?", "What is that building?",
        )) assertRoute(said, "describe_photo")
        for (said in listOf("Open the camera.", "Camera.", "Say cheese.")) assertRoute(said, "take_photo")
        for (said in listOf("Open the map.", "show map")) assertRoute(said, "where_am_i")
        assertRoute("What street is this?", "place")
        assertRoute("What's my location?", "place")
    }

    @Test
    fun notesLeaveFeelingsAndStoriesAlone() {
        for (said in listOf("What's my name?", "What's my mood today?", "What's my favourite food?", "Remember when we went to Prague?")) {
            val c = route(said)
            assertTrue("\"$said\" -> ${c?.name}", c == null || c.name !in setOf("recall_note", "remember_note"))
        }
        assertRoute("Dont forget my bike is at the station.", "remember_note", "text" to "my bike is at the station")
    }

    @Test
    fun normalizeRepairsCommonMishearings() {
        assertEquals("you're so cute", Router.normalize("Youre so cute"))
        assertEquals("i'm lost", Router.normalize("im lost"))
        assertEquals("let's dance", Router.normalize("lets dance"))
        assertEquals("what's the time", Router.normalize("Watch the time"))
        assertEquals("are you okay", Router.normalize("Are you okay?"))
        assertEquals("set a timer for 5 minutes", Router.normalize("Set a timer for 5 minutes, okay?"))
        assertRoute("High val, looking cute today.", "smalltalk", "kind" to "love")
        assertRoute("Hey well.", "smalltalk", "kind" to "greet")
        assertRoute("Night.", "smalltalk", "kind" to "night")
    }

    @Test
    fun moreTimerPhrases() {
        assertRoute("Could you set me a timer for 2 minutes?", "set_timer", "minutes" to 2.0)
        assertRoute("Count down from one minute.", "set_timer", "minutes" to 1.0)
        assertRoute("Val, can you time five minutes?", "set_timer", "minutes" to 5.0)
        assertRoute("Add one more minute.", "timer", "op" to "add")
        assertEquals(1.0, route("Add one more minute.")!!.args.getDouble("minutes"), 1e-9)
    }

    @Test
    fun startsMisheardOnThePhoneStillRoute() {
        // Moonshine base on the reference phone.
        assertEquals("place", Router.rule(Router.normalize("Veramai currently."))?.name)
        assertEquals("navigate_to", Router.rule(Router.normalize("There is Dresden, Hovbahnhof."))?.name)
        assertNull(Router.rule(Router.normalize("there is a cat on the roof")))
    }
}
