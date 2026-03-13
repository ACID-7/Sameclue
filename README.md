# SameClue

Real-time word matching game built with static frontend files and Firebase Realtime Database.

## Current behavior

- Supports 2 to 8 players in a room
- 10 rounds per game
- All players see the same secret word each round
- Any clue used by 2 or more players scores for those players
- Matching players get 2 points
- A room-wide matching streak of 3 or more rounds gives matched players +1 bonus point
- If someone leaves during an active match, the room is reset back to the lobby to avoid broken game state

## Files

- `index.html`: app screens and markup
- `style.css`: app styles
- `app.js`: Firebase sync and game logic
- `words.js`: curated base word packs
- `extraWords.js`: generated 4,500-word expansion list

## Firebase

`app.js` already contains the Firebase web config for project `sameclue-1b0fa`.

Recommended Realtime Database rules for this prototype:

```json
{
  "rules": {
    "rooms": {
      "$roomCode": {
        ".read": true,
        ".write": true
      }
    }
  }
}
```

## Local run

Because this app uses ES modules, serve the folder with a static server instead of opening `index.html` directly from disk.

Example:

```bash
npx serve .
```

Then open the local URL from the server output.

## Deploy

This project is deployable as a static site. `netlify.toml` is configured to publish the repository root.

## Notes

- `extraWords.js` is generated data. Keep it as a plain module import.
- There is no backend auth or anti-cheat layer yet. Anyone with the room code can read and write room state under the current rules.
