/**
 * spell-choosing.js — Spell Preparation Helper
 * For: Foundry VTT V12–V14, dnd5e system v5.x, 2024 rules
 *
 * After a long rest, opens a dialog letting the player choose which spells to
 * prepare for the day. One tab per spellcasting class:
 *   • Wizard — prepares from spells already in the spellbook (owned spell items).
 *   • Cleric / Druid / Paladin / Ranger — prepares from the full class spell list
 *     available in the world (PHB + Tasha's + any registered custom lists).
 *
 * Cantrips and always-prepared spells (subclass/domain/circle grants) are shown
 * but locked, and never count against the prepared-spell limit.
 */

const MODULE_ID = "spell-choosing";

// dnd5e spell preparation states (CONFIG.DND5E.spellPreparationStates):
//   0 = unprepared, 1 = prepared, 2 = always prepared
const PREP = { UNPREPARED: 0, PREPARED: 1, ALWAYS: 2 };

// ── Module API ────────────────────────────────────────────────────────────────

Hooks.once("init", () => {
    game.modules.get(MODULE_ID).api = {
        open: openPrepDialog
    };
});

// ── Themed-dialog styling fix (borrowed from eladrin-species / daily-lands) ─────
// DialogV2 force-adds the `dialog` class, which the dnd5e2 theme uses to trigger
// compact, title-hidden styling. Strip it so we get the full themed-app look.
// (Our dialog's own listeners are wired up in openPrepDialog, where the actor
// context is available for live write-through.)
Hooks.on("renderDialogV2", (app, element) => {
    if (!app.options.classes?.includes("dnd5e2")) return;
    element.classList.remove("dialog");
    const footer = element.querySelector("footer.form-footer");
    if (footer) footer.style.paddingTop = "0.75em";
});

// ── Trigger: long rest completed ───────────────────────────────────────────────

Hooks.on("dnd5e.restCompleted", async (actor, data) => {
    if (!data?.longRest) return;
    if (!actor?.isOwner) return;
    if (!getPreparedCasterClasses(actor).length) return;

    // Let the rest dialog/UI fully close before rendering our dialog.
    await new Promise(r => setTimeout(r, 300));
    openPrepDialog(actor);
});

// ── Class discovery ─────────────────────────────────────────────────────────────

/**
 * Find the actor's spellcasting classes that prepare spells daily.
 * @param {Actor5e} actor
 * @returns {Array<{item: Item5e, identifier: string, max: number, maxLevel: number}>}
 */
function getPreparedCasterClasses(actor) {
    const out = [];
    for (const item of actor.items) {
        if (item.type !== "class") continue;
        const sc = item.system.spellcasting;
        const max = sc?.preparation?.max ?? 0;
        // A prepared caster has a computed preparation limit > 0.
        if (!sc || max <= 0) continue;
        const identifier = item.system.identifier || item.identifier || item.name.slugify();
        out.push({
            item,
            identifier,
            max,
            maxLevel: maxCastableLevel(actor, item)
        });
    }
    return out;
}

/** Highest spell level the actor currently has slots for (cap on what can be prepared). */
function maxCastableLevel(actor, classItem) {
    const slots = actor.system.spells ?? {};
    let highest = 0;
    for (let lvl = 1; lvl <= 9; lvl++) {
        if ((slots[`spell${lvl}`]?.max ?? 0) > 0) highest = lvl;
    }
    // Pact magic, if present, can also raise the ceiling.
    const pactLevel = slots.pact?.level ?? 0;
    return Math.max(highest, pactLevel);
}

/** Is this class a wizard-style "prepare from your spellbook" caster? */
function usesSpellbook(identifier) {
    return identifier === "wizard";
}

// ── Spell source resolution ─────────────────────────────────────────────────────

/**
 * Resolve the class identifier a spell item is tied to, read directly from
 * system.sourceItem (e.g. "class:wizard"). We deliberately avoid the deprecated
 * SpellData#sourceClass getter (removed in dnd5e 6.0). Returns the class
 * identifier only for "class:" sources; null for subclass/other/unattributed.
 */
function spellSourceClass(spellItem) {
    const source = spellItem.system?.sourceItem;
    if (typeof source === "string" && source.startsWith("class:")) return source.slice(6);
    return null;
}

/**
 * Build the selectable spell pool for one class.
 * @returns {Promise<Array<object>>} normalized entries:
 *   { uuid, name, level, school, prepared (0|1|2), locked, owned, itemId }
 */
async function buildSpellPool(actor, cls) {
    if (usesSpellbook(cls.identifier)) return buildSpellbookPool(actor, cls);
    return buildClassListPool(actor, cls);
}

/** Wizard: pool = spell items already on the actor for this class. */
function buildSpellbookPool(actor, cls) {
    const entries = [];
    for (const item of actor.items) {
        if (item.type !== "spell") continue;
        if (item.system.method !== "spell") continue;
        // Only this class's spells (unattributed spells are included as a fallback).
        const src = spellSourceClass(item);
        if (src && src !== cls.identifier) continue;

        const level = item.system.level ?? 0;
        const prepared = item.system.prepared ?? PREP.UNPREPARED;
        entries.push({
            uuid: item.uuid,
            itemId: item.id,
            identifier: item.system?.identifier,
            name: item.name,
            level,
            school: item.system.school,
            prepared,
            owned: true,
            // Cantrips and always-prepared spells cannot be toggled.
            locked: level === 0 || prepared === PREP.ALWAYS
        });
    }
    return entries.sort(sortSpells);
}

/** Cleric/Druid/Paladin/Ranger: pool = full class spell list available in the world. */
async function buildClassListPool(actor, cls) {
    const list = dnd5e.registry?.spellLists?.forType?.("class", cls.identifier);
    if (!list) {
        ui.notifications.warn(`No spell list registered for ${cls.identifier}.`);
        return [];
    }

    // Map of already-owned spell items for this class, keyed by dnd5e identifier
    // (stable across compendium sources — the same key daily-lands matches on).
    const owned = new Map();
    for (const item of actor.items) {
        if (item.type !== "spell" || item.system.method !== "spell") continue;
        const src = spellSourceClass(item);
        if (src && src !== cls.identifier) continue;
        const id = item.system?.identifier;
        if (id) owned.set(id, item);
    }

    const entries = [];
    const seen = new Set(); // dedupe: the registry aggregates multiple list pages
                            // (core SRD + PHB module), so one spell appears under
                            // several UUIDs — collapse to one row per identifier.
    for (const uuid of list.uuids) {
        const idx = await fromUuid(uuid);
        if (!idx) continue; // compendium not installed/enabled — skip
        const identifier = idx.system?.identifier;
        if (identifier && seen.has(identifier)) continue;
        if (identifier) seen.add(identifier);

        const level = idx.system?.level ?? 0;
        if (level === 0) continue;             // cantrips are not prepared daily
        if (level > cls.maxLevel) continue;    // beyond current slots

        const ownedItem = identifier ? owned.get(identifier) : null;
        const prepared = ownedItem?.system.prepared ?? PREP.UNPREPARED;
        entries.push({
            uuid,
            itemId: ownedItem?.id ?? null,
            identifier,
            name: idx.name,
            level,
            school: idx.system?.school,
            prepared,
            owned: !!ownedItem,
            locked: prepared === PREP.ALWAYS
        });
    }
    return entries.sort(sortSpells);
}

function sortSpells(a, b) {
    return (a.level - b.level) || a.name.localeCompare(b.name);
}

// ── Dialog rendering ─────────────────────────────────────────────────────────────

function levelLabel(level) {
    return CONFIG.DND5E.spellLevels?.[level] ?? (level === 0 ? "Cantrips" : `Level ${level}`);
}

// Compact label for the level tabs (1st, 2nd, … 9th) to minimize horizontal space.
function ordinalLevel(level) {
    if (level === 0) return "Cantrips";
    return ({ 1: "1st", 2: "2nd", 3: "3rd" }[level]) ?? `${level}th`;
}

function schoolLabel(school) {
    return CONFIG.DND5E.spellSchools?.[school]?.label ?? "";
}

function countPrepared(pool) {
    // Only level>0, prepared===1 spells count toward the limit.
    return pool.filter(s => s.level > 0 && s.prepared === PREP.PREPARED).length;
}

// Dataset attributes that make an element show the dnd5e rich item tooltip on
// hover (mirrors the system's own `.item-tooltip` wiring, e.g. dnd5e.mjs ~71080).
// The attribute value is single-quoted so its inner double quotes stay valid HTML.
function spellTooltipAttrs(uuid) {
    return `data-tooltip='<section class="loading" data-uuid="${uuid}">`
        + `<i class="fas fa-spinner fa-spin-pulse"></i></section>' `
        + `data-tooltip-class="dnd5e2 dnd5e-tooltip item-tooltip" `
        + `data-tooltip-direction="LEFT"`;
}

function renderClassTab(cls, pool, index, active) {
    const used = countPrepared(pool);
    const rows = pool.map(s => {
        const checked = s.prepared !== PREP.UNPREPARED ? "checked" : "";
        const disabled = s.locked ? "disabled" : "";
        const tag = s.prepared === PREP.ALWAYS
            ? `<span class="sc-tag">always</span>`
            : s.level === 0 ? `<span class="sc-tag">cantrip</span>` : "";
        // Rich dnd5e item tooltip on hover — same mechanism the system uses for its
        // own spell lists: a lazy "loading" tooltip keyed on the spell's UUID, which
        // game.dnd5e.tooltips resolves to the spell's richTooltip() card document-wide.
        const tipData = spellTooltipAttrs(s.uuid);
        return `
          <li class="sc-spell${s.locked ? " locked" : ""}" data-name="${s.name.toLowerCase()}"
              data-level="${s.level}" ${tipData}>
            <label>
              <input type="checkbox" name="prep" value="${s.uuid}" ${checked} ${disabled}
                     data-class="${cls.identifier}" data-level="${s.level}">
              <span class="sc-name">${s.name}</span>
              <span class="sc-school">${schoolLabel(s.school)}</span>
              ${tag}
            </label>
          </li>`;
    }).join("");

    // One level tab per spell level present in the pool (single-select; first active).
    const levels = [...new Set(pool.map(s => s.level))].sort((a, b) => a - b);
    const levelTabs = levels.map((lvl, i) =>
        `<button type="button" class="sc-leveltab${i === 0 ? " active" : ""}" data-level="${lvl}">${ordinalLevel(lvl)}</button>`
    ).join("");

    return `
      <section class="sc-tab" data-tab="${index}" style="${active ? "" : "display:none;"}">
        <div class="sc-left">
          <div class="sc-counter">
            <strong>${cls.item.name}</strong>
            <span class="sc-source">${usesSpellbook(cls.identifier) ? "(from spellbook)" : "(from class list)"}</span>
          </div>
          <input type="search" class="sc-search" placeholder="Filter spells…" data-tab="${index}">
          <nav class="sc-levels">${levelTabs}</nav>
          <ul class="sc-list">${rows}</ul>
        </div>
        <aside class="sc-prepared">
          <div class="sc-prepared-head" data-class="${cls.identifier}">
            Prepared — <span class="sc-used">${used}</span> / <span class="sc-max">${cls.max}</span>
          </div>
          <ul class="sc-prepared-list" data-class="${cls.identifier}"></ul>
        </aside>
      </section>`;
}

function buildContent(classData) {
    const tabButtons = classData.map((c, i) =>
        `<button type="button" class="sc-tabbtn${i === 0 ? " active" : ""}" data-tab="${i}">${c.cls.item.name}</button>`
    ).join("");

    const tabs = classData.map((c, i) => renderClassTab(c.cls, c.pool, i, i === 0)).join("");

    return `
      <div class="sc-root">
        <div class="note info" style="margin-bottom:8px;">
          Choose the spells to prepare for the day. Cantrips and always-prepared
          spells are shown for reference and don't count against your limit.
        </div>
        ${classData.length > 1 ? `<nav class="sc-tabs">${tabButtons}</nav>` : ""}
        ${tabs}
      </div>`;
}

// Wire up tab switching, search filtering, and the live prepared counter.
// `root` is the dialog's root element (passed from the renderDialogV2 hook).
function activateListeners(root, actor, classData) {
    if (!root) return;

    const classEntryFor = identifier => classData.find(c => c.cls.identifier === identifier);

    root.querySelectorAll(".sc-tabbtn").forEach(btn => {
        btn.addEventListener("click", () => {
            const tab = btn.dataset.tab;
            root.querySelectorAll(".sc-tabbtn").forEach(b => b.classList.toggle("active", b === btn));
            root.querySelectorAll(".sc-tab").forEach(s => {
                s.style.display = s.dataset.tab === tab ? "" : "none";
            });
        });
    });

    // A row is shown when it matches the active level tab; a non-empty search term
    // overrides the level filter and matches by name across all levels. While a
    // search term is present the section is marked `searching`, which visually
    // clears the level-tab highlight (its selection no longer governs the view).
    const filterSection = section => {
        if (!section) return;
        const term = (section.querySelector(".sc-search")?.value ?? "").toLowerCase().trim();
        section.classList.toggle("searching", !!term);
        const activeLevel = section.querySelector(".sc-leveltab.active")?.dataset.level;
        section.querySelectorAll(".sc-spell").forEach(li => {
            const show = term
                ? li.dataset.name.includes(term)
                : li.dataset.level === activeLevel;
            li.style.display = show ? "" : "none";
        });
    };

    // Select a level tab in a section (clearing any text filter), then re-filter.
    const activateLevel = (section, level) => {
        if (!section) return;
        const search = section.querySelector(".sc-search");
        if (search) search.value = "";
        section.querySelectorAll(".sc-leveltab").forEach(b =>
            b.classList.toggle("active", b.dataset.level === String(level)));
        filterSection(section);
    };

    root.querySelectorAll(".sc-leveltab").forEach(btn => {
        btn.addEventListener("click", () => activateLevel(btn.closest(".sc-tab"), btn.dataset.level));
    });

    // Clicking a spell in the right-hand "Prepared" column jumps the left list to
    // that spell's level. Delegated, since the column is rebuilt on every sync.
    root.querySelectorAll(".sc-prepared-list").forEach(listEl => {
        listEl.addEventListener("click", event => {
            const item = event.target.closest(".sc-prepared-item");
            if (!item?.dataset.level) return;
            const section = listEl.closest(".sc-tab");
            activateLevel(section, item.dataset.level);
            // Bring the matching row into view in the left list.
            const row = section?.querySelector(`.sc-spell input[value="${CSS.escape(item.dataset.uuid)}"]`)
                ?.closest(".sc-spell");
            row?.scrollIntoView({ block: "nearest" });
        });
    });

    root.querySelectorAll(".sc-search").forEach(input => {
        input.addEventListener("input", () => filterSection(input.closest(".sc-tab")));
    });

    // Apply the initial level filter to every class panel.
    root.querySelectorAll(".sc-tab").forEach(filterSection);

    // Live write-through: each toggle applies to the actor immediately. The actor
    // is the single source of truth; the UI is then re-synced from it (here for a
    // snappy response, and again via the actor-change hooks in openPrepDialog).
    root.querySelectorAll(`input[name="prep"]`).forEach(box => {
        box.addEventListener("change", async () => {
            await onToggle(actor, classEntryFor(box.dataset.class), box);
            syncFromActor(root, actor, classData);
        });
    });

    // Reflect the actor's current state into the dialog right away.
    syncFromActor(root, actor, classData);
}

// Find the actor's spell item backing a pool entry (the wizard's spellbook item,
// or a class-list spell matched by identifier within this class).
function findActorSpell(actor, cls, entry) {
    if (usesSpellbook(cls.identifier) && entry.itemId) {
        const byId = actor.items.get(entry.itemId);
        if (byId) return byId;
    }
    if (!entry.identifier) return null;
    return actor.items.find(i => i.type === "spell"
        && i.system?.method === "spell"
        && i.system?.identifier === entry.identifier
        && (spellSourceClass(i) ?? cls.identifier) === cls.identifier) ?? null;
}

// Apply a single checkbox toggle to the actor (the write-through). Rejects and
// reverts the checkbox if preparing would exceed the class's prepared-spell limit.
async function onToggle(actor, classEntry, box) {
    if (!classEntry) return;
    const { cls, pool } = classEntry;
    const entry = pool.find(s => s.uuid === box.value);
    if (!entry || entry.locked) return;
    const want = box.checked;

    if (want && entry.level > 0) {
        const used = cls.item.system.spellcasting?.preparation?.value ?? 0;
        const alreadyPrepared = findActorSpell(actor, cls, entry)?.system.prepared === PREP.PREPARED;
        if (!alreadyPrepared && used >= cls.max) {
            box.checked = false; // revert the click
            ui.notifications.warn(`${cls.item.name}: prepared-spell limit of ${cls.max} reached.`);
            return;
        }
    }

    try {
        await applyToggle(actor, cls, entry, want);
    } catch (err) {
        console.error(`${MODULE_ID} | failed to apply "${entry.name}"`, err);
        ui.notifications.error(`Couldn't update ${entry.name}. See console.`);
    }
}

// Write one spell's prepared state to the actor.
//   • Wizard: flip system.prepared on the existing spellbook item.
//   • Class-list caster: create the spell (preparing one the actor doesn't own),
//     flip an existing one, or delete the module-created copy when un-preparing.
async function applyToggle(actor, cls, entry, want) {
    if (usesSpellbook(cls.identifier)) {
        const item = findActorSpell(actor, cls, entry);
        if (item && item.system.prepared !== (want ? PREP.PREPARED : PREP.UNPREPARED)) {
            await item.update({ "system.prepared": want ? PREP.PREPARED : PREP.UNPREPARED });
        }
        return;
    }

    const existing = findActorSpell(actor, cls, entry);
    if (want && !existing) {
        const doc = await fromUuid(entry.uuid);
        if (!doc) return;
        const data = doc.toObject();
        delete data._id;                                  // don't carry the compendium id
        if (data.system) delete data.system.preparation;  // drop any legacy field
        data.system.method = "spell";
        data.system.prepared = PREP.PREPARED;
        data.system.sourceItem = `class:${cls.identifier}`;
        foundry.utils.setProperty(data, `flags.${MODULE_ID}.managed`, true);
        await actor.createEmbeddedDocuments("Item", [data]);
    } else if (want && existing && existing.system.prepared !== PREP.PREPARED) {
        await existing.update({ "system.prepared": PREP.PREPARED });
    } else if (!want && existing) {
        // Remove if we created it; otherwise just unprepare.
        if (existing.getFlag(MODULE_ID, "managed")) await existing.delete();
        else if (existing.system.prepared !== PREP.UNPREPARED) {
            await existing.update({ "system.prepared": PREP.UNPREPARED });
        }
    }
}

// Reflect the actor's current spell state into the dialog: each checkbox's checked
// and locked state, and each class's "used / max" counter (from the system's own
// authoritative prepared count). Setting .checked programmatically fires no events.
function syncFromActor(root, actor, classData) {
    if (!root) return;
    for (const { cls, pool } of classData) {
        const byUuid = new Map(pool.map(e => [e.uuid, e]));
        const prepared = []; // for the right-hand "Prepared" column
        root.querySelectorAll(`input[name="prep"][data-class="${cls.identifier}"]`).forEach(box => {
            const entry = byUuid.get(box.value);
            if (!entry) return;
            const state = findActorSpell(actor, cls, entry)?.system.prepared ?? PREP.UNPREPARED;
            box.checked = state !== PREP.UNPREPARED;
            const lock = entry.level === 0 || state === PREP.ALWAYS;
            box.disabled = lock;
            box.closest(".sc-spell")?.classList.toggle("locked", lock);
            if (entry.level > 0 && state !== PREP.UNPREPARED) {
                prepared.push({ name: entry.name, level: entry.level, uuid: entry.uuid, always: state === PREP.ALWAYS });
            }
        });

        const used = cls.item.system.spellcasting?.preparation?.value ?? 0;
        const counter = root.querySelector(`.sc-prepared-head[data-class="${cls.identifier}"]`);
        if (counter) {
            const usedEl = counter.querySelector(".sc-used");
            if (usedEl) usedEl.textContent = used;
            counter.classList.toggle("over", used > cls.max);
        }

        renderPreparedColumn(root, cls, prepared);
    }
}

// Rebuild the right-hand "Prepared" column for a class from its current loadout,
// grouped implicitly by the level-then-name sort. Always-prepared spells are tagged.
function renderPreparedColumn(root, cls, prepared) {
    const listEl = root.querySelector(`.sc-prepared-list[data-class="${cls.identifier}"]`);
    if (!listEl) return;
    prepared.sort((a, b) => (a.level - b.level) || a.name.localeCompare(b.name));
    listEl.innerHTML = prepared.length
        ? prepared.map(s => `
            <li class="sc-prepared-item" data-level="${s.level}" data-uuid="${s.uuid}" ${spellTooltipAttrs(s.uuid)}>
              <span class="sc-pl-lvl">${ordinalLevel(s.level)}</span>
              <span class="sc-pl-name">${s.name}</span>
              ${s.always ? `<span class="sc-tag">always</span>` : ""}
            </li>`).join("")
        : `<li class="sc-prepared-empty">None prepared</li>`;
}

// ── Main entry point ─────────────────────────────────────────────────────────────

async function openPrepDialog(actor) {
    if (!actor) return;
    const classes = getPreparedCasterClasses(actor);
    if (!classes.length) {
        ui.notifications.info(`${actor.name} has no prepared-caster classes.`);
        return;
    }

    // Resolve pools for each class up front (async compendium lookups).
    const classData = [];
    for (const cls of classes) {
        const pool = await buildSpellPool(actor, cls);
        classData.push({ cls, pool });
    }

    const dialog = new foundry.applications.api.DialogV2({
        window: { title: `Prepare Spells — ${actor.name}` },
        classes: ["dnd5e2", MODULE_ID],
        // Wide enough for the spell picker on the left plus the "Prepared" column on
        // the right; tall enough that both boxes fill the window nicely (they flex
        // to fill — see CSS).
        position: { width: 860, height: 760 },
        content: buildContent(classData),
        // Edits apply live, so there's nothing to confirm and no button — close via
        // the window's X. (DialogV2 requires a button to be defined, so we declare a
        // close action and hide the footer in CSS.)
        buttons: [{ action: "close", label: "Close" }],
        rejectClose: false
    });

    await dialog.render({ force: true });
    activateListeners(dialog.element, actor, classData);

    // Keep the open dialog in sync with the actor — whether changes come from this
    // dialog's own toggles or from the player editing the character sheet directly.
    const relevant = item => item?.parent?.uuid === actor.uuid && item.type === "spell";
    const refresh = item => { if (relevant(item)) syncFromActor(dialog.element, actor, classData); };
    const hookIds = [
        ["createItem", Hooks.on("createItem", refresh)],
        ["updateItem", Hooks.on("updateItem", refresh)],
        ["deleteItem", Hooks.on("deleteItem", refresh)]
    ];
    let closeId;
    const onClose = app => {
        if (app !== dialog) return;
        for (const [name, id] of hookIds) Hooks.off(name, id);
        Hooks.off("closeDialogV2", closeId);
    };
    closeId = Hooks.on("closeDialogV2", onClose);
}
