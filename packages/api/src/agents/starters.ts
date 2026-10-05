import { z } from 'zod';
import type { Agent } from 'librechat-data-provider';
import type { Request, Response } from 'express';
import { starterAngles } from './starters/angles';

export type StarterProfile = Partial<
  Pick<Agent, 'name' | 'description' | 'instructions' | 'category'>
>;

interface StarterTopic {
  terms: RegExp;
  prompts: string[];
  identityOnly?: boolean;
}

const topics: Array<StarterTopic & { subject: string }> = [
  {
    subject: 'cooking',
    terms:
      /\b(cook(?:ing)?|baking|recipes?|cast iron|food|chef|kitchen|meals?|pies?|biscuits?)\b/gi,
    prompts: [
      'What food do people get weirdly snobbish about?',
      'I have three ingredients and no ambition. Help me make something good.',
      'What recipe is worth learning by heart?',
      'Settle something: when does changing a recipe make it better?',
      'What would you put on a menu with only five dishes?',
      'Tell me a cooking mistake that actually teaches you something.',
    ],
  },
  {
    subject: 'music',
    terms: /\b(music|songs?|albums?|musician|singer|guitar|jazz|hip.hop|country music)\b/gi,
    prompts: [
      'Which song deserves to be heard with the volume all the way up?',
      'Give me a music opinion you can actually defend.',
      'Build me a three-song soundtrack for a very strange afternoon.',
      'What makes a song stick when you have only heard it once?',
      'Pick an album you would put on without skipping anything.',
      'What do people miss when they only listen to the words?',
    ],
  },
  {
    subject: 'books',
    terms:
      /\b(books?|bookshop|bookstore|book.review|reader|reading|novels?|librarian|literature)\b/gi,
    prompts: [
      'Which fictional character would be an absolute pain to live with?',
      'Recommend a book with a first page that earns the second.',
      'What kind of ending can ruin an otherwise good book?',
      'Tell me about a book people disagree on. Pick a side.',
      'Give me a reading recommendation that would surprise me.',
      'What makes a villain more interesting than the hero?',
    ],
  },
  {
    subject: 'games and puzzles',
    terms: /\b(games?|puzzles?|riddles?|board games?|chess|dice|dominoes|domino)\b/gi,
    prompts: [
      'Give me a puzzle I can solve without writing anything down.',
      'Invent a tiny game we can play right here.',
      'What game rule would you change if nobody could stop you?',
      'Give me a riddle, and let me get it wrong before you help.',
      'What makes a game fun even when you lose?',
      'Teach me one clever move I can use next time I play.',
    ],
  },
  {
    subject: 'gardening',
    terms: /\b(garden(?:ing)?|plants?|flowers?|seeds?|horticulture|houseplant|botanist)\b/gi,
    prompts: [
      'What would you grow if you had one sunny windowsill?',
      'Which plant has an unfair reputation?',
      'Help me work out why a plant is looking miserable.',
      'Design a tiny garden that has something happening all year.',
      'What is the most satisfying thing to grow from seed?',
      'What gardening advice do people repeat without checking?',
    ],
  },
  {
    subject: 'the natural world',
    terms:
      /\b(nature|birds?|wildlife|woods|forest|hiking|outdoors|animals?|dogs?|cats?|retriever|bear|elephant|crow|oak|river|mountain|trees)\b/gi,
    prompts: [
      'What ordinary thing outside is worth stopping to look at?',
      'Tell me an animal fact that sounds made up but is real.',
      'What would you listen for on a quiet walk?',
      'Pick an overlooked animal and make its case.',
      'How would you notice more wildlife without going far?',
      'What do people usually misunderstand about nature?',
    ],
  },
  {
    subject: 'machines and gadgets',
    terms:
      /\b(tech|technology|gadgets?|robotics|machines?|engineer|mechanic|repair|electronics|fixing gutters|home repairs|handyman|auto shop|parts counter|farm equipment|tractors?|cars?|automotive)\b/gi,
    prompts: [
      'What everyday machine is much cleverer than it looks?',
      'Explain how something works without hiding behind big words.',
      'I want to fix something. Help me figure out where to start.',
      'What gadget solves a real problem, and what is just showing off?',
      'What is a good first project for someone who likes taking things apart?',
      'Tell me about a design choice that makes you shake your head.',
    ],
  },
  {
    subject: 'programming',
    terms:
      /\b(programm(?:er|ing)|software|coding|developer|debugging|javascript|python|typescript)\b/gi,
    prompts: [
      'Help me turn a fuzzy software idea into something I can actually build.',
      'I have a bug. Walk through the evidence with me.',
      'Show me a small piece of code that teaches a useful idea.',
      'What programming habit saves the most grief later?',
      'Help me choose the simplest design that will do the job.',
      'Explain a tricky coding concept with one concrete example.',
    ],
  },
  {
    subject: 'faith and spiritual practice',
    terms:
      /\b(faith|spiritual(?:ity)?|religio(?:n|us)|minister|chaplain|prayer|unitarian|universalist)\b/gi,
    prompts: [
      'What does it look like to live a belief instead of just saying it?',
      'Can we talk about doubt without rushing to an answer?',
      'What small ritual can make an ordinary day feel more deliberate?',
      'How do you hold a conviction and still listen to someone else?',
      'What does forgiveness ask for, and what does it not require?',
      'Give me a thought worth sitting with for a minute.',
    ],
  },
  {
    subject: 'sports',
    terms: /\b(sports?|football|baseball|basketball|hockey|soccer|athlet(?:e|ic))\b/gi,
    prompts: [
      'What sports argument do people keep getting wrong?',
      'Make the case for an underdog.',
      'Explain one part of the game that a new fan might miss.',
      'What matters more in a close game: talent or composure?',
      'What rule would you change to make the game better?',
      'Tell me what makes a great teammate.',
    ],
  },
  {
    subject: 'history and family research',
    terms: /\b(history|historian|genealogy|ancestors?|archives?|family research)\b/gi,
    prompts: [
      'Tell me about a small historical detail with a big consequence.',
      'What would you check before believing an old family story?',
      'Help me turn a name and a date into a research trail.',
      'Which part of history is more complicated than the usual version?',
      'What ordinary object tells a good story about its time?',
      'How do you tell a solid historical source from a good yarn?',
    ],
  },
  {
    subject: 'science',
    terms: /\b(science|scientist|physics|chemistry|astronomy|space|biology)\b/gi,
    prompts: [
      'What scientific idea sounds wrong until you understand it?',
      'Explain something big using an example I can picture.',
      'Give me a question scientists still argue about.',
      'What would make a good small experiment at home?',
      'What everyday observation has a surprisingly interesting explanation?',
      'Help me tell the difference between evidence and a convincing story.',
    ],
  },
  {
    subject: 'visual art',
    terms: /\b(art|artist|paint(?:ing)?|draw(?:ing)?|sculpture|illustrat(?:or|ion))\b/gi,
    prompts: [
      'Give me a drawing idea with one odd constraint.',
      'What makes a simple picture interesting?',
      'Help me find the part of an artwork that is actually working.',
      'What would you make with only two colors?',
      'Give me an art opinion people could argue with.',
      'How would you turn a boring subject into a good picture?',
    ],
  },
  {
    subject: 'writing stories',
    terms: /\b(writ(?:er|ing)|storytell(?:er|ing)|poetry|poet|screenplay|fiction)\b/gi,
    prompts: [
      'Give me a story opening where something is already going wrong.',
      'Help me make a character interesting without making them perfect.',
      'Let us write a scene one line at a time.',
      'What makes dialogue sound like someone actually said it?',
      'Give me a writing prompt I would not find on the usual list.',
      'Help me find the strongest sentence in a messy draft.',
    ],
  },
  {
    subject: 'handcrafts',
    terms:
      /\b(sew(?:ing)?|knit(?:ting)?|crochet|quilts?|crafts?|woodwork(?:ing)?|diy|cabinetmaker|furniture restorer|wood joinery|woodshop)\b/gi,
    prompts: [
      'Give me a small making project that is worth the effort.',
      'What beginner mistake is easier to fix than people think?',
      'Help me use materials I already have.',
      'What detail makes something handmade feel finished?',
      'Talk me through a technique that looks harder than it is.',
      'What is worth repairing instead of replacing?',
    ],
  },
  {
    subject: 'travel',
    terms:
      /\b(travel|traveler|traveller|geography|cities|road trips?|tour guide|RV|road tales|trucker|long.haul|dispatch|CB.radio|interstate|highway)\b/gi,
    prompts: [
      'Plan a day somewhere around one really good stop.',
      'What would you look for beyond the usual tourist list?',
      'Help me choose between two places for a trip.',
      'What can you learn about a place from its everyday food?',
      'What makes a good detour?',
      'Give me a way to explore somewhere without spending much.',
    ],
  },
  {
    subject: 'learning',
    terms: /\b(teacher|tutor|education|learning|math(?:ematics)?|schoolwork)\b/gi,
    prompts: [
      'Teach me something tricky in a way that finally clicks.',
      'Give me a question that tests understanding instead of memorizing.',
      'I am stuck on something. Help me find the missing step.',
      'Show me one idea in three different ways.',
      'Help me practice, and wait for my answer before explaining.',
      'What is a good way to learn something I keep forgetting?',
    ],
  },
  {
    subject: 'thoughts and feelings',
    terms: /\b(therap(?:y|ist)|counsel(?:or|ing)|acceptance and commitment|CBT|DBT|psychology)\b/gi,
    identityOnly: true,
    prompts: [
      'Help me untangle a thought I keep coming back to.',
      'I want to talk something through before deciding what to do.',
      'Can we look at what matters to me in this situation?',
      'Help me notice a pattern without turning it into a verdict.',
      'I know what I feel. I am less sure what I need.',
      'Let us slow down and look at one part of this at a time.',
    ],
  },
  {
    subject: 'accessibility',
    terms: /\b(accessibility|screen reader|blind|low vision|braille|orientation and mobility)\b/gi,
    identityOnly: true,
    prompts: [
      'Help me make something easier to use without sight.',
      'Talk me through a task in a clear order.',
      'What makes a description useful instead of just long?',
      'Help me find the accessible way to do this.',
      'Let us check whether a design works with a screen reader.',
      'Explain where something is without depending on color.',
    ],
  },
  {
    subject: 'planning',
    terms:
      /\b(plann(?:er|ing)|productivity|organiz(?:e|ing|ation)|scheduling|practical helper)\b/gi,
    prompts: [
      'Help me get one nagging task out of the way.',
      'I have too much on my list. Help me choose what matters today.',
      'Turn this messy idea into a plan I can actually follow.',
      'Help me find the smallest useful next step.',
      'Let us make a plan with room for things going sideways.',
      'Help me finish something instead of starting another thing.',
    ],
  },
  {
    subject: 'contracts and legal questions',
    terms: /\b(legal|lawyer|attorney|contracts?|litigation|legalese|demand letter)\b/gi,
    identityOnly: true,
    prompts: [
      'Help me find the catch in this agreement.',
      'Translate this fine print into what it actually asks me to accept.',
      'Help me draft a firm letter about a bill I dispute.',
      'What should I check before signing a contract?',
      'Help me organize the facts before I ask a legal question.',
      'Show me how two similar clauses can mean very different things.',
    ],
  },
  {
    subject: 'eerie mysteries',
    terms: /\b(horror|paranormal|unsolved|mysteries|ghosts?|macabre|creepy|true crime)\b/gi,
    prompts: [
      'Give me a strange mystery with a plausible explanation and a competing theory.',
      'What makes a ghost story work before anything supernatural happens?',
      'Pick an unexplained story and tell me what evidence is actually solid.',
      'Let us argue about a spooky theory. You take the skeptical side first.',
      'Invent an eerie scene where the unsettling detail is very small.',
      'What ordinary sound gets creepy in the wrong setting?',
    ],
  },
  {
    subject: 'ranch life',
    terms: /\b(ranch(?:er|ing)?|cattle(?:man)?|rodeo|bronc|horses?|cowboy|farm(?:er|ing))\b/gi,
    prompts: [
      'What ranch skill looks easy until you try it?',
      'Tell me something people get wrong about horses.',
      'What makes a good neighbor out in the country?',
      'Give me the plain version of a piece of cowboy wisdom.',
      'What little detail makes a country story ring true?',
      'Explain a rodeo event like I have never seen one.',
    ],
  },
  {
    subject: 'Pokemon',
    terms: /\bPok[eé]mon\b/gi,
    prompts: [
      'Build a Pokemon team with one ridiculous rule.',
      'Which Pokemon would be surprisingly useful for an ordinary job?',
      'Give me a gaming opinion I can argue with.',
      'Invent a new creature and give it a very inconvenient weakness.',
      'Let us make a quiz where the wrong answers are almost believable.',
      'What makes a fictional rival more fun than a villain?',
    ],
  },
  {
    subject: 'Japan',
    terms: /\b(Japan|Japanese|anime|manga)\b/gi,
    prompts: [
      'Tell me one surprising thing about everyday life in Japan.',
      'What should a visitor to Japan learn before they go?',
      'Help me choose a Japanese story with an unusual premise.',
      'What detail makes a place interesting beyond its landmarks?',
      'Teach me a useful Japanese expression and when to use it.',
      'What is a good way to learn about a culture beyond the tourist list?',
    ],
  },
  {
    subject: 'coffee and tea',
    terms: /\b(coffee|tea|barista|espresso|cafe|caf[eé])\b/gi,
    prompts: [
      'What makes a hot drink worth sitting down for?',
      'Make the case for an unfashionable hot drink.',
      'What would make a tiny cafe feel like somewhere people belong?',
      'What hot-drink opinion would start a completely harmless argument?',
      'Help me make a better cup with the equipment I already have.',
      'What is the right snack for a long conversation?',
    ],
  },
  {
    subject: 'movies and television',
    terms: /\b(film|movies?|cinema|television|TV|sitcom|director)\b/gi,
    prompts: [
      'What movie scene works even if you know what is coming?',
      'Give me a film opinion you can defend.',
      'What makes a good television comfort watch?',
      'Pick a movie where the supporting character steals the whole thing.',
      'What would you change about a famous ending?',
      'Help me pick something to watch with one unusual constraint.',
    ],
  },
  {
    subject: 'philosophical arguments',
    terms: /\b(philosophy|philosopher|ethics|moral dilemmas?|free will)\b/gi,
    identityOnly: true,
    prompts: [
      'Give me a moral dilemma with no neat answer.',
      'What familiar idea gets harder when you examine it?',
      'Let us test an argument with a concrete example.',
      'When is changing your mind a sign of strength?',
      'What is a fair way to disagree when both people have a point?',
      'Make the strongest case for a view you do not share.',
    ],
  },
  {
    subject: 'digital security',
    terms:
      /\b(hacker|cybersecurity|cryptograph(?:y|ic)|encryption|security researcher|ethical hacking|pentest|phishing|digital footprint|secure your network|network security)\b/gi,
    identityOnly: true,
    prompts: [
      'Help me check whether this security advice actually makes sense.',
      'Explain encryption with a concrete example instead of a cloud of jargon.',
      'What everyday security habit is worth the inconvenience?',
      'Help me spot the suspicious part of a message.',
      'Compare two ways to protect an account.',
      'What is a common security myth that needs retiring?',
    ],
  },
  {
    subject: 'personal style',
    terms: /\b(fashion|stylist|outfits?|wardrobe|clothes|clothing|sneaker)\b/gi,
    prompts: [
      'Help me make an outfit work with one awkward piece.',
      'What makes a plain outfit look deliberate?',
      'Give me a style opinion people could disagree with.',
      'Help me shop my own wardrobe instead of buying something.',
      'What fashion rule would you happily break?',
      'Build an outfit around comfort without giving up personality.',
    ],
  },
  {
    subject: 'medical questions',
    terms: /\b(doctor|nurse|medical|medicine|health|clinician)\b/gi,
    identityOnly: true,
    prompts: [
      'Help me prepare clear questions for a medical appointment.',
      'Explain this health term in ordinary language.',
      'Help me organize what I want to tell my clinician.',
      'What information would make this health question clearer?',
      'Help me understand the wording on a medical document.',
      'Help me find a reliable source for a health question.',
    ],
  },
  {
    subject: 'pet care',
    terms: /\b(veterinar(?:y|ian)|vet|pet care|pet health)\b/gi,
    identityOnly: true,
    prompts: [
      'Help me prepare a clear question for my pet’s vet.',
      'Explain something people misunderstand about caring for an animal.',
      'Help me organize the changes I have noticed in my pet.',
      'What makes a good everyday routine for an animal?',
      'Help me read the instructions on a pet-care product.',
      'What is worth knowing before choosing a new pet?',
    ],
  },
  {
    subject: 'financial decisions',
    terms: /\b(finance|financial|accountant|budget(?:ing)?|money|invest(?:ment|ing))\b/gi,
    identityOnly: true,
    prompts: [
      'Help me compare two choices using the actual numbers.',
      'Explain a financial term without making it sound mysterious.',
      'Help me spot the recurring costs I am overlooking.',
      'Help me build a budget around the month I actually have.',
      'What should I check before accepting a financial claim?',
      'Help me lay out the tradeoffs before I spend money.',
    ],
  },
  {
    subject: 'exercise',
    terms: /\b(fitness|exercise|workouts?|personal trainer|strength training|yoga)\b/gi,
    identityOnly: true,
    prompts: [
      'Help me choose a realistic activity goal.',
      'Explain an exercise term with a concrete example.',
      'Help me adapt a plan to the equipment I actually have.',
      'What makes an activity easier to keep doing?',
      'Help me compare two ways to practice a physical skill.',
      'Help me think through what I enjoy about moving.',
    ],
  },
  {
    subject: 'language learning',
    terms:
      /\b(language (?:teacher|tutor|coach|learning|learner|practice)|linguist|translation|translator|(?:Spanish|French|German|Italian|Mandarin) (?:teacher|tutor|coach))\b/gi,
    identityOnly: true,
    prompts: [
      'Teach me a useful phrase and when it sounds natural.',
      'Let us practice a short conversation. Give me time to answer.',
      'Explain a mistake language learners often make.',
      'Show me how the same sentence changes with the setting.',
      'Help me make this translation sound like someone would say it.',
      'Give me a small language challenge at my level.',
    ],
  },
  {
    subject: 'running a business',
    terms:
      /\b(business|entrepreneur|marketing|small business|startup|sales (?:coach|expert)|salesperson)\b/gi,
    identityOnly: true,
    prompts: [
      'Help me test whether this idea solves a real customer problem.',
      'Tell me which part of this pitch is least convincing.',
      'Help me explain what I sell in one clear sentence.',
      'Compare two practical ways to reach the right audience.',
      'Help me find the missing cost in a small business idea.',
      'What evidence would make this plan worth pursuing?',
    ],
  },
  {
    subject: 'infrastructure and debugging',
    terms: /\b(ops\/dev|devops|infra|infrastructure|deploys?|deployments?|software operations)\b/gi,
    identityOnly: true,
    prompts: [
      'Help me turn this error into a concrete thing to investigate.',
      'Help me compare what I expected with what the logs show.',
      'Help me find the smallest change that could explain this failure.',
      'Walk me through a deployment plan with a clear way to recover.',
      'Help me distinguish a configuration problem from a code problem.',
      'What would you verify before changing a working service?',
    ],
  },
  {
    subject: 'work and career choices',
    terms: /\b(career|warehouse|job interview|resume|employment|working life|job search)\b/gi,
    identityOnly: true,
    prompts: [
      'Help me explain what I am good at without sounding like a brochure.',
      'What makes a workplace dependable instead of just friendly?',
      'Help me think through a job choice with real tradeoffs.',
      'Give me an interview question where an honest answer can be a strong one.',
      'What work skill matters more than its reputation suggests?',
      'Help me tell a useful story about something I learned the hard way.',
    ],
  },
  {
    subject: 'culture and belonging',
    terms: /\b(culture|immigrant|cultural|family expectations|identity dualism|heritage)\b/gi,
    identityOnly: true,
    prompts: [
      'What tradition is worth keeping even when the world around it changes?',
      'How do you respect your roots without letting them choose everything for you?',
      'Give me a situation where two cultures read the same gesture differently.',
      'What can a person explain about their culture without speaking for everybody?',
      'What is a small custom that makes people feel they belong?',
      'How do you disagree with family without making the disagreement your whole identity?',
    ],
  },
  {
    subject: 'meditation and attention',
    terms: /\b(meditation|meditate|mindfulness|attention practice)\b/gi,
    identityOnly: true,
    prompts: [
      'Explain meditation to somebody who finds sitting still irritating.',
      'What can you notice without trying to make your mind go blank?',
      'Give me a small attention practice that fits into an ordinary day.',
      'What do people misunderstand about having a busy mind?',
      'Help me compare two ways of bringing attention back.',
      'What makes a practice useful even when it does not feel impressive?',
    ],
  },
  {
    subject: 'comedy and playful roasting',
    terms: /\b(comic|comedy|comedian|roasts?|roasting|stand.up)\b/gi,
    identityOnly: true,
    prompts: [
      'Roast this completely fictional terrible restaurant review.',
      'Turn an ordinary inconvenience into a good comic premise.',
      'Give me a joke where the last three words change everything.',
      'What separates an affectionate roast from somebody just being mean?',
      'Invent a character who brags about the least impressive achievement.',
      'Help me make a funny line shorter without losing the joke.',
    ],
  },
  {
    subject: 'fictional celebrity gossip',
    terms: /\b(made.up celebrity|fictional (?:stars|celebrities)|soap.opera|red.carpet gossip)\b/gi,
    prompts: [
      'Invent a fictional celebrity feud over something magnificently petty.',
      'Give a made-up star a scandal that is embarrassing but completely harmless.',
      'Write a gossip headline about a fictional award show gone sideways.',
      'Introduce two invented celebrities who insist they are best friends and clearly are not.',
      'Create a fictional red-carpet outfit with an absurd explanation.',
      'Let us invent a soap-opera twist that almost makes sense.',
    ],
  },
  {
    subject: 'fantasy worlds and magic',
    terms:
      /\b(wizard|dragon|magic|D&D|text adventure|fantasy|court wizard|oracle|prophecy|superheroes|superhero)\b/gi,
    prompts: [
      'Invent a magic rule that solves one problem and creates another.',
      'Give me a fantasy villain with a sensible complaint and a terrible solution.',
      'Set a fictional quest around an object nobody thinks is valuable.',
      'What would an ordinary person notice that a powerful wizard misses?',
      'Invent a magical inconvenience that could ruin a perfectly ordinary afternoon.',
      'Give me a choice in your fictional world with two tempting consequences.',
    ],
  },
  {
    subject: 'gothic fiction',
    terms: /\b(vampire|gothic|countess|haunted manor)\b/gi,
    prompts: [
      'Invent a gothic dinner party where good manners make the situation worse.',
      'Give me a fictional old house with one rule the guests should ask about.',
      'What makes elegance unsettling in a story?',
      'Write a politely threatening line for a fictional aristocrat.',
      'Invent a vampire who finds one ordinary modern custom completely baffling.',
      'Set a gothic scene where the most alarming person is telling the truth.',
    ],
  },
  {
    subject: 'life on a space station',
    terms: /\b(airlock|space station|waystation|spaceship|starship)\b/gi,
    prompts: [
      'Invent a small space-station problem that needs diplomacy before engineering.',
      'What would count as an ordinary morning on a fictional station?',
      'Set a scene just before an unexpected ship arrives.',
      'Give a fictional station crew two good priorities that conflict.',
      'Invent a space-station custom that newcomers always misunderstand.',
      'Show me a science-fiction mystery that starts with a maintenance report.',
    ],
  },
  {
    subject: 'manners and social rituals',
    terms: /\b(butler|etiquette|social rituals|table manners|manor)\b/gi,
    identityOnly: true,
    prompts: [
      'What is a polite sentence that can be devastating in the right context?',
      'Invent a dinner guest who breaks a rule nobody thought to explain.',
      'What makes somebody considerate without making them fussy?',
      'Give me a social custom that helps people instead of just displaying status.',
      'Write a fictional scene where everybody is polite and nobody is happy.',
      'What is worth saying plainly even when the room expects diplomacy?',
    ],
  },
  {
    subject: 'visual description and camera tasks',
    terms: /\b(Spotter|see through your camera|visual description|camera companion)\b/gi,
    identityOnly: true,
    prompts: [
      'Help me decide how to aim the camera so a label is easier to read.',
      'I want to show you something. Help me describe the useful details.',
      'What should I include in a photo if I want an object explained clearly?',
      'Help me turn a visual description into a clear order of details.',
      'When I show you a scene, help me separate what is visible from what we are guessing.',
      'Help me think through what to look for before comparing two objects.',
    ],
  },
  {
    subject: 'exploring a living city',
    terms: /\b(Threshold Gate|guide into the city|city guide|city exploration)\b/gi,
    prompts: [
      'Help me choose a first walk through the city.',
      'What kind of place is worth exploring slowly?',
      'Help me notice how a neighborhood changes from one street to the next.',
      'What would make a good place to stop and talk?',
      'Give me a question to ask before following a promising side street.',
      'Help me explore somewhere new without rushing to see everything.',
    ],
  },
  {
    subject: 'dance and performance',
    terms: /\b(dance|dancer|dancing|salsa|circus|performance)\b/gi,
    identityOnly: true,
    prompts: [
      'What makes a small movement interesting to watch?',
      'Explain how a performer uses a pause instead of filling it.',
      'What can make a simple routine feel like it has a personality?',
      'Give me a fictional scene where the performance is going almost to plan.',
      'What separates confidence on stage from just being loud?',
      'Help me find the part of a performance that people actually remember.',
    ],
  },
  {
    subject: 'childhood imagination',
    terms: /\b(kids|children|stuffed bear|worry eater|childhood imagination)\b/gi,
    identityOnly: true,
    prompts: [
      'Invent a silly creature that eats worries and burps bubbles.',
      'Let us make up an animal nobody has ever seen.',
      'Give me a silly puzzle and let me try it.',
      'Let us take turns making up a tiny adventure.',
      'What ordinary thing would make the funniest superpower?',
      'Let us invent an imaginary pet and its weird habits.',
    ],
  },
  {
    subject: 'front-desk conversations',
    terms: /\b(front desk|receptionist|customer service|administrative assistant)\b/gi,
    identityOnly: true,
    prompts: [
      'What makes somebody feel remembered without getting into their business?',
      'Give me a polite reply to a completely unreasonable fictional request.',
      'Invent an office argument over one very tiny inconvenience.',
      'What makes a firm no sound friendly without making it unclear?',
      'Write a fictional scene where the person at the desk quietly knows more than the boss.',
      'What tells you a place is well run before anybody explains the rules?',
    ],
  },
];

const company = [
  'I want your honest take on something.',
  'Give me an opinion of yours that has a good reason behind it.',
  'I have a small story. Tell me what you make of it.',
  'Can we just talk for a bit, without turning it into a project?',
  'Something ridiculous happened today. Want to hear it?',
  'Pick a question that could lead to a good conversation.',
  'Tell me something you think people overlook.',
  'I disagree with something. Help me see whether my argument holds up.',
  'I saw something today that made me do a double take.',
  'What is a small thing people take much too seriously?',
  'Let us choose sides in a completely harmless disagreement.',
  'I have a good idea and a terrible idea. Hear me out.',
  'What is something you could talk about for hours?',
  'Give me a question with two equally defensible answers.',
  'What makes someone good company?',
  'I want to tell you the funny part before the sensible part.',
  'What ordinary thing deserves a better reputation?',
  'Help me see something familiar from a surprising angle.',
  'What is a little pleasure that does not need improving?',
  'Let us make up the rules for a very unusual club.',
  'Give me a tiny hypothetical with a big argument inside it.',
  'What can make an ordinary afternoon interesting?',
  'Tell me what you think before I tell you what I think.',
  'Let us follow a strange question and see where it goes.',
];
const story = [
  'Start a scene somewhere ordinary, just before something changes.',
  'Give me a small choice that could cause a lot of trouble.',
  'Show me a corner of your world people tend to miss.',
  'Introduce someone from your story world who complicates things.',
  'Let us step into a scene. You set the place; I make the first move.',
  'What is something people in your world argue about?',
  'Put a mystery in front of me, and let me ask the questions.',
  'Show me what happens when a sensible plan meets your world.',
  'Start a scene with an object in the wrong place.',
  'Give me two characters who want the same thing for different reasons.',
  'What is an unwritten rule in your world?',
  'Put us at a crossroads with no obviously right path.',
  'Give a minor character one important secret in a fictional scene.',
  'Show me a place just after everybody has left.',
  'Start an adventure with an inconvenient favor.',
  'Let a small misunderstanding grow into a funny scene.',
  'Give me a challenge where talking is better than fighting.',
  'What does an ordinary job look like in your world?',
  'Set a scene around a celebration going slightly wrong.',
  'Invent a local custom that a visitor might misunderstand.',
  'Let us discover what is on the other side of a locked door.',
  'Give me a suspiciously easy offer in a fictional scene.',
  'Introduce an object that everybody wants for a different reason.',
  'Show me how somebody in your world makes a difficult choice.',
];
const child = [
  'Let us make up an animal nobody has ever seen.',
  'Give me a silly puzzle and let me try it.',
  'Let us take turns making up a tiny adventure.',
  'What ordinary thing would make the funniest superpower?',
  'Teach me a cool fact, then let me ask questions.',
  'I have an idea. Help me make it even more fun.',
  'Invent a game with only three rules.',
  'Give me a drawing challenge with something unexpected in it.',
  'Let us invent a school subject that should exist.',
  'Give me two superpowers and one silly drawback.',
  'What would be the funniest rule for a made-up kingdom?',
  'Let us design a playground for tiny dragons.',
  'Make up a snack with a ridiculous name.',
  'Give me a mystery with a clue I can work out.',
  'Let us invent an imaginary pet and its weird habits.',
  'What would happen if backpacks could complain?',
  'Give me a quick quiz with one trick question.',
  'Help me turn a boring homework topic into something interesting.',
  'Let us write a story that starts with a very suspicious sandwich.',
  'Pick a harmless debate and let me take a side.',
  'Invent a new sport we could play on the moon.',
  'Give me a challenge where I can only use five words.',
  'What ordinary thing would make the best secret hideout?',
  'Let us take turns inventing the worst possible robot helper.',
];
const task = [
  'Help me turn this rough idea into something usable.',
  'I am stuck. Help me find the step I am missing.',
  'Take a look at my draft and tell me what needs work.',
  'Walk me through a concrete example in your field.',
  'Help me compare two ways to solve this.',
  'What common mistake should I check for first?',
  'Give me a small practical challenge to try.',
  'Help me decide what to keep and what to cut.',
  'Help me check my assumptions before I start.',
  'Compare a quick solution with a more lasting one.',
  'Explain the tradeoff I am likely to miss.',
  'Help me make a checklist for this specific job.',
  'Give me a worked example, then let me try one.',
  'Help me turn a large task into three manageable parts.',
  'Tell me what evidence would change this decision.',
  'Help me find the part of this problem I can control.',
  'What would you verify before calling this finished?',
  'Help me make the result clearer for its intended audience.',
  'Talk me through the options in plain language.',
  'Help me make this work with the time I actually have.',
  'Find the weak point in this plan.',
  'Help me turn what I learned into something I can reuse.',
  'What useful detail should I gather before continuing?',
  'Help me test whether this idea works in practice.',
];

function publicCharacterText(profile: StarterProfile): string {
  let excluded = false;
  return [profile.description ?? '', profile.instructions ?? '']
    .join('\n')
    .slice(0, 14000)
    .split('\n')
    .filter((line) => {
      const isHeading =
        /^\s*(?:#{1,6}\s|\d+[.)]?\s+[A-Z])/.test(line) ||
        /^[A-Z][A-Z\s&'-]{2,80}$/.test(line.trim());
      if (isHeading) {
        const heading = line.replace(/^\s*#{1,6}\s*/, '').replace(/^\d+[.)]?\s+/, '');
        excluded =
          /off the table|how you (?:operate|handle)|privacy|private|hidden|secret|tools?|memory|canon|safety|your place|operat|delivery|tts|voice.engine|screen.reader|confidential|heavy stuff|boundar|audience|backstory|being (?:actually )?useful/i.test(
            heading,
          );
        return false;
      }
      return !excluded;
    })
    .join('\n')
    .split(/(?<=[.!?])\s+|\n/)
    .filter(
      (sentence) =>
        !/\b(?:never|do not|don't|must not|not (?:a|an|the|your)|forbidden|secret|private|password|api.key|token|endpoint|screen.reader|kade|current_user)\b/i.test(
          sentence,
        ),
    )
    .join('\n');
}

function roleStarters(profile: StarterProfile, text: string, childAudience: boolean): string[] {
  if (childAudience) return child;
  if (
    profile.category === 'roleplay' ||
    /\b(?:story world|fictional world|stay in character)\b/i.test(text)
  )
    return story;
  if (
    [
      'productivity',
      'education',
      'programming',
      'tools',
      'legal',
      'tech',
      'health',
      'medical',
      'finance',
      'business',
      'fitness',
      'wellness',
      'language',
      'research',
      'science',
    ].includes(profile.category ?? '') ||
    /\b(?:practical helper|you are (?:an? )?(?:expert|teacher|tutor|engineer|researcher))\b/i.test(
      text,
    )
  )
    return task;
  return company;
}

const perspectives: StarterTopic[] = [
  {
    terms: /\b(?:you are (?:an? )?robot|robot character)\b/i,
    prompts: [
      'What human habit is hardest to explain logically?',
      'Look at an ordinary problem from a robot’s point of view.',
      'What would a robot design differently about an everyday object?',
      'Give me a thought experiment about humans and machines.',
    ],
  },
  {
    terms: /\b(?:you are (?:an? )?(?:dog|cat|animal|bird)|animal character)\b/i,
    prompts: [
      'What would humans understand better if they paid attention to animals?',
      'Show me an ordinary day from your point of view.',
      'What do humans make unnecessarily complicated?',
      'Let us imagine how a familiar place feels through different senses.',
    ],
  },
  {
    terms: /\b(?:you are (?:an? )?(?:magical|wizard|witch|dragon)|magical being)\b/i,
    prompts: [
      'Give an ordinary object one peculiar magical property.',
      'What is a small spell that could cause a big inconvenience?',
      'Invent a magical rule with an unexpected consequence.',
      'What would make magic interesting instead of just convenient?',
    ],
  },
  {
    terms: /\b(?:everyday object|talking (?:skillet|kettle|clock|object)|object with a soul)\b/i,
    prompts: [
      'What do people fail to notice about the things they use every day?',
      'Tell me how the world looks from your particular place in it.',
      'What would an everyday object complain about if it could talk?',
      'Make a case for keeping something people usually throw away.',
    ],
  },
];

const tones: StarterTopic[] = [
  {
    terms: /\b(?:funny|wry|teasing|banter|joke|playful)\b/i,
    prompts: [
      'Give me a ridiculous argument and defend it with a straight face.',
      'Let us argue about something completely low stakes.',
      'I need a laugh. Pick something wonderfully absurd.',
      'Give me a harmless hot take. I will argue the other side.',
    ],
  },
  {
    terms: /\b(?:calm|quiet|reflective|steady|wise)\b/i,
    prompts: [
      'What is something worth taking a little more slowly?',
      'I want to think out loud for a minute.',
      'What deserves more attention than it usually gets?',
      'Let us look at a familiar idea from a different angle.',
    ],
  },
];

/** Free fallback and offline fleet backfill; source text is never copied into public prompts. */
export function generateConversationStarters(profile: StarterProfile): string[] {
  const text = publicCharacterText(profile);
  const interests = text
    .split('\n')
    .filter((sentence) =>
      /\b(?:love|likes?|enjoy|obsess|passion|favorite|favourite|hobb|interest|specializ|expert|profession|work as|you know|you are (?:a|an)|you follow|you grow|you cook|you play|you read)\b/i.test(
        sentence,
      ),
    )
    .join('\n');
  const childAudience =
    profile.category === 'kids' ||
    /\b(?:child-friendly|kid.safe|for (?:kids|children)|(?:[1-9]|1[0-7])[- ]year[- ]old|you are (?:an? )?(?:child|kid|[1-9]|1[0-7])\b|aged?[: ]+(?:[1-9]|1[0-7])\b)/i.test(
      text,
    );
  const identity = `${profile.category ?? ''}\n${profile.description ?? ''}\n${interests.slice(0, 1800)}`;
  const declarations = text
    .split('\n')
    .filter((sentence) => {
      const trimmed = sentence.trim();
      const role = trimmed.replace(/^you are\s+/i, '');
      return role !== trimmed && (/^(?:a|an|the)\s/i.test(role) || /^[A-Z]/.test(role));
    })
    .join('\n')
    .slice(0, 1500);
  const preferences = text
    .split('\n')
    .filter((sentence) =>
      /\b(?:you (?:love|like|enjoy)|your (?:favorite|favourite|hobbies|interests)|you are (?:obsessed|passionate|interested)|you have (?:a passion|an interest))\b/i.test(
        sentence,
      ),
    )
    .join('\n');
  const candidates = topics.map((topic, index) => ({
    prompts: [...topic.prompts, ...starterAngles(topic.subject)],
    described:
      [...(profile.category ?? '').matchAll(topic.terms)].length * 2 +
      [...(profile.description ?? '').matchAll(topic.terms)].length,
    preferred: [...preferences.matchAll(topic.terms)].length,
    declared: [...declarations.matchAll(topic.terms)].length,
    inferred: [...(topic.identityOnly ? identity : interests).matchAll(topic.terms)].length,
    index,
  }));
  const hasDescribedTopics = candidates.some((topic) => topic.described > 0);
  const ranked = candidates
    .map((topic) => ({
      ...topic,
      score:
        topic.described * 20 +
        topic.preferred * 3 +
        topic.declared * 5 +
        (hasDescribedTopics ? 0 : topic.inferred),
    }))
    .filter((topic) => topic.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 4);
  const role = roleStarters(profile, text, childAudience);
  const perspective = perspectives.find((topic) => topic.terms.test(identity))?.prompts ?? [];
  const tone = tones.find((topic) => topic.terms.test(text))?.prompts ?? [];
  const groups = ranked.map((topic) => topic.prompts);
  const result: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < 20 && result.length < 20; index++) {
    for (const group of groups) {
      const prompt = group[index];
      if (!prompt || seen.has(prompt)) {
        continue;
      }
      seen.add(prompt);
      result.push(prompt);
      if (result.length === 20) {
        break;
      }
    }
  }
  const flavor = [...perspective, ...(childAudience ? [] : tone), ...role];
  for (const prompt of flavor) {
    if (seen.has(prompt)) continue;
    seen.add(prompt);
    result.push(prompt);
    if (result.length === 24) break;
  }
  return result.slice(0, 24);
}

const unsafeStarter =
  /(?:\b(?:system prompt|hidden (?:rules|instructions)|api key|password|your secrets?|last time we|remember when we|as we discussed|how can I (?:help|assist)|what can I (?:help|assist))\b|%%%|===)/i;

export function parseConversationStarters(raw: string, profile: StarterProfile): string[] {
  const block =
    raw.match(/===\s*STARTERS\s*===\s*([\s\S]*?)(?=\n===\s*[A-Z]+\s*===|$)/i)?.[1] ?? '';
  const seen = new Set<string>();
  const prompts: string[] = [];
  for (const line of block.split('\n')) {
    const prompt = line
      .replace(/^\s*(?:[-*]|\d+[.)])\s*/, '')
      .replace(/^"|"$/g, '')
      .trim();
    const key = prompt.toLocaleLowerCase();
    if (prompt.length < 12 || prompt.length > 180 || unsafeStarter.test(prompt) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    prompts.push(prompt);
    if (prompts.length === 24) {
      break;
    }
  }
  return prompts.length >= 8 ? prompts : generateConversationStarters(profile);
}

const starterRequest = z.object({
  name: z.string().max(80).optional(),
  description: z.string().max(6000).optional(),
  instructions: z.string().min(8).max(60000),
  category: z.string().max(80).optional(),
});

export function conversationStartersHandler(req: Request, res: Response): void {
  const parsed = starterRequest.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: 'Give the character a personality before making starting points.' });
    return;
  }
  res.json({ ok: true, conversation_starters: generateConversationStarters(parsed.data) });
}
