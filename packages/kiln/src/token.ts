import { randomBytes } from "node:crypto";

/**
 * The harness's bearer token: four words, like `apple-venison-rainbow-copper`.
 *
 * It used to be 32 random bytes in hex — 64 characters nobody can read, transcribe or say out loud.
 * That is the wrong shape for what this token actually is: a credential one person copies from the
 * machine running the harness to the machine they want to connect from, or reads off a screen and
 * types into another app. A year of hex tokens produced exactly one behaviour, which was everyone
 * pasting them into notes and chat messages.
 *
 * Four words from a 1,933-entry list carry about 43.7 bits. That is not a defence against an attacker
 * who already holds a copy of the file — but neither was 256 bits, because the file was the thing
 * that leaked. It *is* a defence against guessing over the network: a host answering 200 requests a
 * second would need roughly 700 years to expect a hit. The honest trade is a token that is easy to
 * retype from one screen into another, which is the thing people actually do with it.
 *
 * Two consequences worth stating, because they are decisions rather than accidents:
 *
 * - **Nothing validates the shape.** The harness compares the string it read from disk with the
 *   string in the request. A 64-character hex token from an older install keeps working forever, so
 *   upgrading does not silently lock anyone out of their own machine.
 * - **A word may repeat.** Stripping repeats would leak the draw; independence is what makes the
 *   count the actual strength.
 *
 * **This list is a copy.** `electron/tokenWords.ts` holds the same words for the desktop app, which
 * cannot import this file (electron main is compiled with `rootDir: electron`). They are kept
 * identical by `tokenWords.test.ts`; neither may be edited alone.
 */

/**
 * A roster of short, concrete, unambiguous words: no homophones, and nothing that differs from a
 * neighbour by one letter. Roughly alphabetical by theme so it stays reviewable by eye.
 */
const WORDS = `able acorn actor adobe agent agile aisle alarm album alert alien alley almond alpha amber anchor angle ankle answer antler anvil aper apple apricot apron arch archer arctic arena argon armor arrow aspen atlas atom attic auger aunt aurora autumn avenue axiom azure badge bagel baker balance balcony ballad ballot bamboo banana bandit banjo barley barn basil basin basket baton bayou beach beacon beam bean beard beast beaver bed bee beef beetle bell belly belt bench bend berry beryl birch bird biscuit bishop bison bit blade blanket blaze blender blimp block bloom blossom blue bluff board boat bobcat bodhi boiler bolt bone bonnet bonus book boot border bottle bough boulder bounce bow bowl box braid branch brass brave bread breeze brick bridge brief bright brine brisk brook broom brush bubble bucket buckle bud buffalo bugle bulb bull bundle bunny burlap bus butter button cabin cable cactus cadet cage cairn cake calico camel camera camp canal candle candy cane canoe canopy canvas canyon cape captain car card cargo carpet carrot cart carver cascade cashew casino castle cat cedar ceiling cell cellar cement chai chain chair chalk chamber chard charm chart cheese chef cherry chess chest chick chili chime chimney chin chip chive chocolate choir chord cider cinch circle citron city clam clamp clarinet clay clean clear clever cliff climate clinic cloak clock cloud clover club clue coach coal coast coat cobble cocoa coconut coffee coin cold collar comet compass cone cookie cool copper coral cord corgi cork corn cornet corral cotton couch cougar count course court cove crab cradle craft crane crater crawl crayon cream creek crest cricket crisp crop cross crow crowd crown cruise crumb crystal cube cuckoo cue cup curl current curve cushion custom cycle dab dad daisy dance dandelion danger dapper dare dark dart dash date dawn day deal dear debate deck decor deer delta den dense depot depth desert desk detail dew diamond dice diesel digit dime dimple diner dingo dinner diode direct disk ditch dive dock doctor dodge dog dollar dolphin dome donkey donut door dot dough dove down dozen draft dragon drain drama draw dream dress drift drill drink drive drizzle drone drum dry duck dune dusk dust dutch duty dwarf dye eagle ear early earth easel east easy echo eclipse edge eel egg eight elbow elder electric elegant element elephant elevator elf elm ember emerald empty ending engine english enjoy enough entry envy epic equal equip eraser escape espresso essay estate ether ethics evening event ever exact exam exit expert eye fabric face fact fade fair falcon fall fame family fan fancy farm fast father fault favor fawn feast feather fed fee fence fern ferry festival fever few fiber fiction field fig fight figure file fill film final finch find fine finger finish fir fire firm first fish five flag flame flash flat flax fleet flesh flicker flight flint float flock flood floor flour flow flower fluent flute fly foam fog foil fold folk food foot forest forge fork form fort fossil four fox frame free fresh friday fridge friend frog front frost fruit fuel full fun fur furnace future gadget galaxy gallery garden garlic gate gather gauge geese gem general gentle genuine geology germ get ghost giant gift ginger giraffe girl give glacier glad glass glaze gleam glide globe glove glow glue goat gold golf good goose gorilla gourd govern grab grace grain grand grape grass grave gravel gray great green greet grid grill grip grove grow guard guest guide guitar gull gust gym habit hail hair half hall hammer hamster hand handle harbor hard hare harmony harp harvest hat hatch haul hawk hay hazel head health heart heat heavy hedge heel height helios hello helmet hen heron hickory hidden high hill hinge hint hip hire history hive hobby hockey hold hole holiday hollow home honey hood hoof hook hope horizon horn horse host hot hotel hour house hub hue huge human humble humid humor hundred hunt hurdle hut hybrid hydrant hymn ice icon idea idle igloo image imprint inch index indigo indoor infant ink inlet inner input insect inside instant iris iron island item ivory ivy jack jacket jade jaguar jam jar jasmine jaw jazz jeans jelly jet jewel job jockey jog join joke journal joy judge jug juice july jump june jungle junior juniper just kale kayak keep kestrel kettle key kid kidney kind king kiosk kiss kit kite kitten kiwi knee knife knight knit knob knot know koala koi label labor lace ladder lady lake lamb lamp lance land lane lantern lap large lark laser last latch late laugh launch laundry lava lawn layer lazy lead leaf league lean leap learn lease leather leave ledge leek left leg legend lemon lend length lens lentil leopard lesson letter level lever library lichen lid life lift light lilac lily lime limit line linen link lint lion lip liquid list little live lizard llama load loaf loan lobby lobster local lock lodge loft log logic lonely long look loom loop loose lord lotus loud love low loyal lucid lucky lumber lunar lunch lupine lush lute luxury lynx lyric macaw machine madam magic magnet maid mail main maize major make mall malt mammal manage mango manor maple marble march mare margin marina mark market marsh mask mason mast mat match mate math matrix matter meadow meal mean measure meat medal media medium meet melody melon member memory mend menu mercury mercy merge merit merry mesh message metal meteor method middle midnight mild mile milk mill mind mine mint minute mirror mist mitten mix moat modern modest mojo money monkey month moon moose moped morning mortar moss motel moth motion motor mound mount mouse mouth move movie mow mud muffin mug mule museum mushroom music mustang mustard mute myth nail name nap napkin narrow nation native nature navy near neat nectar needle neighbor neon nest net nettle network new news next nice nickel night nine noble nod node noise nomad noon north nose note novel now nugget number nurse nut oak oasis oat obey object ocean october odd offer office often oil old olive omega onion online only onward opal open opera orange orbit orchard orchid order organ orient origin otter ounce outer oval oven over owl own ox oxide oyster pace pack pad page pager pail pain paint pair pale palm pan panda pane panel panther pantry paper parade parcel pardon park parrot parsley part party pass pasta pastel path patio patrol pattern pause pave paw pay peach peak peanut pear pebble pecan pedal peel pen pencil penguin penny people pepper perch peridot pet petal pewter phase phone photo phrase piano pick picnic picture pie piece pier pigeon pile pillar pilot pine pink pint pipe pistachio pit pitch pixel pizza place plaid plain plane planet plank plant plaster plate play plaza pleasant pledge plenty plot plow plum plume plush pocket poem poet point polar pole pollen pond pony poodle pool poppy porch port pose post pot potato pottery pouch powder power prairie praise prawn pray present press pretty price pride prim prime print prism prize probe prompt proud prove prune public pud pull pulley pulse pump pumpkin punch pupil puppy purple purse push put puzzle quail quake quart quartz queen quench query quest quick quiet quill quilt quince quiz quote rabbit race rack radar radio radish raft rail rain rainbow raise raisin rally ramp ranch range rapid raspberry rate raven raw ray razor reach read ready real realm reason rebuild receipt record recover red reed reef refer refill reflect region regret reindeer relay release relief relish remain remind remote render renew rent repair repeat replace reply report rescue reserve rest result retina return reveal review reward rhino rhubarb ribbon rice rich ride ridge rifle right rigid rim ring rinse ripe ripple rise risk ritual river road roast robin rock rocket rod rodeo roll roof rookie room rooster root rope rose rotate rough round route row royal rub ruby rudder rug rule run rune rural rush rust rut sack saddle safe saffron sage sail saint salad salmon salon salt salve sample sand santa sapphire sardine satin sauce sauna save saw say scale scan scarf scatter scene scent school science scissors scoop scope score scout scrap screen script scroll sea seal seam search season seat second secret section seed seek seem select self sell send sense sentry sequel serene series serve session set settle seven shade shadow shaft shale shallow shape share shark sharp shave shed sheep sheet shelf shell shelter shield shift shine ship shirt shiver shoe shop shore short shoulder shovel show shrimp shrub shuffle shy sibling side sider siege sigh sight sign silent silk sill silly silver similar simple since sing single sink sip siren sister sit six size skate sketch ski skill skin skip skirt skull sky slate sled sleep sleeve slender slice slide slight slim sling slip slope slot slow small smart smile smith smoke smooth snack snail snake snap snip snow soap soccer sock soda sofa soft soil solar sold soldier solid solve some song soon sort soul sound soup source south space spade spare spark sparrow speak spear special speed spell sphere spice spider spike spin spine spiral spirit splash split spoke sponge spoon sport spot spray spread spring sprout spruce spur square squash squid stable stack stadium staff stage stair stall stamp stand star starch start state station stay steady steam steel steep stem step stern stick stiff still stitch stock stone stool stop store storm story stove straight strand strange straw stream street stretch strike string strong struggle studio study stuff stump style subject submit subtle subway success such sudden sugar suit summer summit sun sunday sunny sunrise sunset super supply support sure surf surge surprise survey swift swim swing switch sword syrup system table tablet tackle tactic tag tail tailor take tale talent talk tall tan tank tape tar target task taste tea teach team tear tech teeth tell temple tempo ten tender tennis tent term terrace test text texture than thank thaw the them then thick thin thing think third thistle thorn thought thread three thrive throat throne throw thumb thunder ticket tidy tiger tight tile till timber time tin tiny tip tire title toast today toe toffee together toilet token tomato tone tongue tool tooth top topic torch total touch tough tour tower town toy trace track trade trail train tram trap travel tray treat tree trek trend trial tribe trick trigger trim trio trip triumph trolley troop trophy tropic trouble trout truck true trumpet trunk trust truth tube tulip tumble tuna tunnel turbo turkey turn turtle tusk twelve twenty twin twist two type ultra umber uncle under uniform union unique unit unite unity until up upper upset urban urge usage use usual utter vacant vacuum vague valet valid valley valve van vanilla vapor variety various vase vast vault vector velvet vendor venture venue verb verify verse very vessel vest veteran vibe video view vigor villa vine vintage violet violin viper virtue visible vision visit vital vocal vivid vogue voice void volcano volume vote voyage waffle wagon waist wait walk wall walnut walrus wander want ward warm warn wash wasp waste watch water wave wax way weak wealth wear weather weave web wedge week weigh weird welcome weld well west wet whale wheat wheel when where while whisk whisper white whole wide widget width wife wild willow win wind window wine wing wink winner winter wire wisdom wise wish wit wolf woman wonder wood wool word work world worm worry worth wrap wreck wrist write wrong yard yarn year yeast yellow yes yet yield yoga yolk young youth zebra zen zero zest zinc zipper zone zoo zoom`;

/**
 * The word list, de-duplicated and frozen.
 *
 * Exported for the CLI's `--help`, for tests, and for anyone writing a token by hand. It is fixed:
 * changing it changes which tokens are *likely*, not which are valid.
 */
export const TOKEN_WORDS: readonly string[] = Object.freeze([...new Set(WORDS.split(/\s+/).filter(Boolean))]);

/** The raw list, so a test can compare this copy with the desktop app's. */
export const TOKEN_WORD_SOURCE = WORDS;

/** Four words: see the note at the top for why that is the number. */
export const TOKEN_WORD_COUNT = 4;

/**
 * A new token. Two bytes per draw gives headroom if the list ever grows past 1,024 entries, and the
 * modulo is uniform because the draw is over `words.length`, not over a fixed 1,024.
 */
export const generateToken = (wordCount = TOKEN_WORD_COUNT): string => {
  const words = TOKEN_WORDS;
  if (words.length === 0) throw new Error("the token word list is empty");
  const picks: string[] = [];
  const bytes = randomBytes(wordCount * 2);
  for (let index = 0; index < wordCount; index += 1) {
    const draw = (bytes[index * 2]! << 8) | bytes[index * 2 + 1]!;
    picks.push(words[draw % words.length]!);
  }
  return picks.join("-");
};

/**
 * Whether a stored value looks like a token this harness would accept.
 *
 * Deliberately permissive: any non-trivial string is a valid credential, because older installs
 * carry 64-character hex and hand-written tokens are legal too. The only thing rejected is a value
 * too short to be anything but a placeholder — a 3-character "token" is a truncated write, and
 * accepting it silently would make every request 401 with no explanation.
 */
export const isUsableToken = (value: string | undefined | null): value is string => {
  const token = value?.trim() ?? "";
  return token.length >= 8;
};
