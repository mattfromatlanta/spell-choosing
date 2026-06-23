# Spell Preparation Helper (`spell-choosing`)

A Foundry VTT v14 module for the **D&D 5e (2024 rules)** system that helps
spellcasters choose which spells to prepare each day.

## What it does

After a character finishes a **long rest**, the module opens a dialog showing
their currently prepared spells and lets them adjust the list. It handles each
prepared-caster class by the rules:

- **Wizard** — prepare from the spells already in your **spellbook** (the spell
  items on your sheet). Scribing new spells into the book is unchanged/out of scope.
- **Cleric, Druid, Paladin, Ranger** — prepare from the **entire class spell
  list** that is available in your world (PHB, Tasha's Cauldron of Everything, and
  any custom spells registered to a class spell list). Selecting a spell adds it
  to your sheet; deselecting one the module added removes it again.

Other details, by the book:

- **Cantrips** and **always-prepared** spells (domain / circle / subclass grants)
  are shown for reference but are locked and never count against your limit.
- Each class's **prepared-spell limit** is read from the class itself and enforced,
  with a live "used / max" counter.
- Spells above your current maximum castable level are hidden.
- **Multiclass** characters get one tab per spellcasting class, each with its own
  source and limit.
- **Live, two-way sync.** Each toggle applies to your character immediately — the
  actor is the single source of truth, so the dialog and the character sheet always
  match. Edits you make on the sheet while the dialog is open are reflected in it
  automatically. There's no separate "save"; just close the dialog when you're done.

## Triggers

- Automatically after a long rest (`dnd5e.restCompleted`).
- Manually via the module API, e.g. in a macro:

  ```js
  game.modules.get("spell-choosing").api.open(actor);
  ```

## Requirements

- Foundry VTT v12+ (verified on v14)
- D&D 5e system v5.x (verified on 5.3.2)

## Installation (development)

Symlink or copy this folder into your Foundry `Data/modules/` directory, then
enable **Spell Preparation Helper** in your world's module settings.
