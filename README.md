# Clues by Sam – Scenario Notes

A [Tampermonkey](https://www.tampermonkey.net/) userscript that adds "what if" scenario notes beside the board of
**[Clues by Sam](https://cluesbysam.com)**, the daily logic puzzle made by Sam.

> **Unofficial, fan-made add-on.** It is not affiliated with, endorsed by, or supported by Clues by Sam or
> Ad Artis Oy. The game and everything in it is Sam's work – see [Credits](#credits).

## Why I made this

I play Clues by Sam often, and I keep needing more notes than the game's top-right and bottom-right corner
tags allow. I use those tags to mark opposite pairs – two people where one has to be innocent and the other
criminal. That leaves no room for what I need to track on top of them: different scenarios, like
*"if A is evil, then B must be good, and C is therefore evil."*

So I wanted somewhere to play a scenario out: a copy of the current board where I can mark people red and green
for one assumption, keep my tag pairs visible, open a second copy for another assumption on the same board, and
later look back at the scenarios I made earlier in the game.

It is meant as a note-keeping aid, not a solver. The add-on never decides anything: who to mark, and how, is
always up to the player.

## What it adds

- **Scenario windows** next to the board, like post-it notes: drag them around, minimize, close and reopen,
  clear, or delete them.
- **Red and green marks** for criminal and innocent, coloured exactly like the game board.
- **A base person** for each scenario – who it is about, e.g. *"If Luisa is criminal"* – highlighted in the
  window and its title.
- **Your corner tags and dimmed clues**, copied from the board, so your opposite pairs stay visible in every
  scenario.
- **Several scenarios per board state.** A new step starts whenever someone is correctly identified. The arrows
  browse scenarios from earlier steps, and starting a new scenario puts the older steps' notes away.
- **Row and column labels** (A–D, 1–5) on every scenario.
- **Two looks:** *Minimal* (compact name tiles) or *Full* (a mini copy of the game board, with optional
  character emojis and clues).
- **Optional faint links** from each scenario to its base person's card on the real board.
- Follows the game's own theme: light/dark, colour palettes and the left-handed layout.
- Notes are saved per puzzle in Tampermonkey's storage; the 60 most recent puzzles are kept.

## Install

1. Install **Tampermonkey** for your browser
   (Chrome: [Chrome Web Store](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)).
2. **Chrome only:** allow userscripts once. Open `chrome://extensions`, click **Details** on Tampermonkey and turn
   on **Allow User Scripts** (on Chrome versions before 138, turn on **Developer mode** instead). Without it,
   userscripts silently don't run – see the [Tampermonkey FAQ](https://www.tampermonkey.net/faq.php?locale=en&q=Q209).
3. Open
   **[clues-by-sam-scenarios.user.js](https://raw.githubusercontent.com/mrironcarbon/cluesbysam-scenarios/main/clues-by-sam-scenarios.user.js)**.
   Tampermonkey shows its install page – click **Install**.
4. Open [cluesbysam.com](https://cluesbysam.com). A small toolbar appears above the board.

Tampermonkey checks this repository for updates automatically.

Built and tested with Chrome and Tampermonkey. Other browsers and userscript managers may work, but are untested.

## How to use

| To…                                       | Do this                                                                                                         |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Start a scenario for the current board    | **+ Scenario**, then click the person it's about: left-click = innocent, right-click = criminal (Esc skips)       |
| Mark someone innocent / criminal          | Left-click / right-click their tile; the same click again clears it                                              |
| Change who the scenario is about          | Star button in the window's title bar, or Shift+click a person                                                  |
| Move / minimize a scenario                | Drag its title bar / double-click the title bar (or use the – button)                                           |
| Clear marks / delete a scenario           | Circular-arrow / bin button – click twice to confirm. Clearing keeps the base person                            |
| Close a scenario / bring closed ones back | × in its title bar / eye button in the toolbar                                                                  |
| See scenarios from earlier board states   | ‹ and › in the toolbar; click the counter between them to jump back to the current board                        |
| Show links to the board                   | Link button in the toolbar                                                                                      |
| Switch between the Minimal and Full look  | Sliders button in the toolbar                                                                                   |
| Help                                      | **?** in the toolbar                                                                                            |

People already revealed on the board can't be marked in a scenario – they are facts, shown as on the board.

## Fair play

- It doesn't solve, hint or check anything, and it doesn't know any answers.
- It only uses what is already visible on your board: names, professions, revealed clues and your own tags.
- It doesn't change the game or your progress, and it sends nothing anywhere – the script makes no network
  requests.
- This repository contains no game content. The *Full* look is drawn on your own page, from the board you're
  already looking at, with the game's own styling.

## Credits

**Clues by Sam** – the game, its puzzles, characters, clues, rules, design, and the corner tags this add-on
builds on – is made by **Sam** and © Ad Artis Oy. All credit for the game goes to Sam. Play it at
[cluesbysam.com](https://cluesbysam.com), and support it with the [puzzle packs](https://cluesbysam.com/s/packs.html)
or a [free account](https://cluesbysam.com/s/home) with weekly bonus puzzles.

**Scenario Notes** – only this userscript – by [@mrironcarbon](https://github.com/mrironcarbon).

If you're Sam and would like something changed, please
[open an issue](https://github.com/mrironcarbon/cluesbysam-scenarios/issues).

## License

The add-on's code is released under the [MIT License](LICENSE). It covers this userscript only; Clues by Sam and
all of its content belong to Ad Artis Oy.
