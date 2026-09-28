// parser.js
// Скачивает реестр иноагентов Минюста через официальный API и формирует JSON
// в формате TextGuard. Запуск: node parser.js (нужен Node.js 18+).

const fs = require("fs");

const BASE_URL =
  "https://reestrs.minjust.gov.ru/rest/registry/39b95df9-9a68-6b6d-e1e3-e6388507067e/values";
const LIMIT = 200;
const OUT_FILE = "foreign_agents.json";

// Тип лица для физических лиц (людей).
const TYPE_PHYSICAL = "Физические лица";

function fetchPage(offset) {
  const url = BASE_URL;
  console.log("Fetching offset", offset);

  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json;charset=utf-8",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Origin": "https://minjust.gov.ru",
      "Referer": "https://minjust.gov.ru/ru/pages/reestr-inostryannykh-agentov/"
    },
    body: JSON.stringify({
      offset: offset,
      limit: LIMIT
    })
  }).then(function (res) {
    if (!res.ok) {
      throw new Error("HTTP " + res.status);
    }
    return res.json();
  });
}

// Извлекает псевдоним из текста в кавычках.
function extractPseudonym(full) {
  const m = full.match(/"([^"]+)"/);
  return m ? m[1] : "";
}

// Убирает из ФИО текст в кавычках (псевдоним) и лишние пробелы.
function cleanFullName(full, pseudonym) {
  let name = full;
  if (pseudonym) {
    name = name.replace(new RegExp('"' + pseudonym + '"', "g"), "");
  }
  name = name.replace(/"/g, "").replace(/\s+/g, " ").trim();
  return name;
}

// Проверяет, является ли псевдоним составным (несколько слов).
function isMultiWord(text) {
  return text.trim().split(/\s+/).length > 1;
}

// Склоняет одиночную фамилию: возвращает {r, d, t, p}.
function declineSurname(surname) {
  const lower = surname.toLowerCase();
  if (surname.length < 3) {
    return null;
  }
  if (lower.endsWith("ь")) {
    const base = surname.slice(0, -1);
    return { r: base + "я", d: base + "ю", t: base + "ем", p: base + "е" };
  }
  if (lower.endsWith("й")) {
    const base = surname.slice(0, -1);
    return { r: base + "я", d: base + "ю", t: base + "ем", p: base + "е" };
  }
  if (lower.endsWith("а")) {
    const base = surname.slice(0, -1);
    return { r: base + "ы", d: base + "е", t: base + "ой", p: base + "е" };
  }
  if (lower.endsWith("я")) {
    const base = surname.slice(0, -1);
    return { r: base + "и", d: base + "е", t: base + "ей", p: base + "е" };
  }
  if (/[бвгджзклмнпрстфхцчшщ]$/.test(lower)) {
    return { r: surname + "а", d: surname + "у", t: surname + "ом", p: surname + "е" };
  }
  return null;
}

// Склоняет одиночное имя: возвращает {r, d, t, p}.
function declineFirstName(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith("ий")) {
    const base = name.slice(0, -1);
    return { r: base + "я", d: base + "ю", t: base + "ем", p: base + "и" };
  }
  if (lower.endsWith("а")) {
    const base = name.slice(0, -1);
    return { r: base + "и", d: base + "и", t: base + "ей", p: base + "и" };
  }
  if (lower.endsWith("я")) {
    const base = name.slice(0, -1);
    return { r: base + "и", d: base + "е", t: base + "ей", p: base + "е" };
  }
  if (/[бвгджзклмнпрстфхцчшщ]$/.test(lower)) {
    return { r: name + "а", d: name + "у", t: name + "ом", p: name + "е" };
  }
  return null;
}

// Собирает склонённые формы "Фамилия Имя".
function declineFullName(surname, firstName) {
  const s = declineSurname(surname);
  const f = declineFirstName(firstName);
  if (!s || !f) {
    return [];
  }
  return [s.r + " " + f.r, s.d + " " + f.d, s.t + " " + f.t, s.p + " " + f.p];
}

// Строит aliases для человека с уровнями confident/possible.
function buildPersonAliases(fullName, pseudonym) {
  const aliases = [];
  const parts = fullName.split(/\s+/).filter(Boolean);

  // Полное ФИО — точное совпадение.
  if (parts.length >= 3) {
    aliases.push({ text: parts.join(" "), level: "confident" });
  }

  // "Фамилия Имя" — возможное совпадение (без отчества нельзя быть уверенным).
  if (parts.length >= 2) {
    aliases.push({ text: parts[0] + " " + parts[1], level: "possible" });
  }

  // Склонённые формы "Фамилия Имя" — possible.
  if (parts.length >= 2) {
    const fullForms = declineFullName(parts[0], parts[1]);
    for (let f = 0; f < fullForms.length; f++) {
      aliases.push({ text: fullForms[f], level: "possible" });
    }
  }

  // Одиночная фамилия — возможное совпадение + склонённые формы.
  if (parts.length >= 1) {
    aliases.push({ text: parts[0], level: "possible" });
    const surnameForms = declineSurname(parts[0]);
    if (surnameForms) {
      aliases.push({ text: surnameForms.r, level: "possible" });
      aliases.push({ text: surnameForms.d, level: "possible" });
      aliases.push({ text: surnameForms.t, level: "possible" });
      aliases.push({ text: surnameForms.p, level: "possible" });
    }
  }

  // Псевдоним.
  if (pseudonym) {
    if (isMultiWord(pseudonym)) {
      aliases.push({ text: pseudonym, level: "confident" });
    } else {
      aliases.push({ text: pseudonym, level: "possible" });
    }
  }

  return aliases;
}

// Префиксы юридической/организационной формы, которые убираем из названия.
const ORG_PREFIXES = [
  "Общество с ограниченной ответственностью",
  "Автономная некоммерческая организация",
  "Некоммерческая организация",
  "Некоммерческое партнерство",
  "Международная общественная организация",
  "Межрегиональная общественная организация",
  "Региональная общественная организация",
  "Общественная организация",
  "Интернет-издание",
  "Интернет-портал",
  "Интернет-проект",
  "Интернет-ресурс",
  "Интернет-журнал",
  "Сетевое издание",
  "Сетевой проект",
  "Сетевой ресурс",
  "Проект",
  "Медиапроект",
  "Медиа-проект",
  "Медиа-группа",
  "Фонд",
  "Благотворительный фонд",
  "Издание",
  "Журнал",
  "Компания",
  "Юридическое лицо",
  "Ассоциация",
  "Общероссийское общественное движение",
  "Общественное движение",
  "Движение",
  "Сообщество",
  "Комьюнити-центр",
  "Центр",
  "Частное учреждение"
];

// Извлекает значимое название организации (короткое, узнаваемое).
function extractOrgName(name) {
  const m = name.match(/[«"]([^»"]+)[»"]/);
  if (m && m[1].trim()) {
    return m[1].trim();
  }

  let rest = name;
  for (let i = 0; i < ORG_PREFIXES.length; i++) {
    if (rest.indexOf(ORG_PREFIXES[i]) === 0) {
      rest = rest.slice(ORG_PREFIXES[i].length).trim();
      break;
    }
  }

  rest = rest.replace(/\(.*\)/g, "").trim();
  rest = rest.replace(/[«»"]/g, "").trim();

  return rest;
}

// Проверяет, есть ли в названии уникальный признак (латиница, цифры, дефис, аббревиатура).
function hasUniqueMark(text) {
  return /[a-zA-Z]/.test(text) || /\d/.test(text) || /-/.test(text) || /^[А-ЯЁ]{2,}$/.test(text);
}

// Строит организации с уровнями.
function buildOrganizationAliases(name) {
  const clean = extractOrgName(name);
  if (!clean) {
    return [];
  }

  const wordCount = clean.split(/\s+/).length;
  // Консервативно: confident только если явно уникальное название.
  // Длинное слово (>=7 букв), многословное (>=3 слов) или есть латиница/цифры/дефис.
  let level;
  const isLongWord = wordCount === 1 && clean.replace(/[^а-яёa-z]/gi, "").length >= 7;
  if (wordCount >= 3 || isLongWord || hasUniqueMark(clean)) {
    level = "confident";
  } else {
    level = "possible";
  }

  return [{ text: clean, level: level }];
}

async function run() {
  const first = await fetchPage(0);
  const size = first.size || 0;
  const totalPages = Math.ceil(size / LIMIT);
  console.log("Total records:", size, "pages:", totalPages);

  const allValues = first.values.slice();
  for (let page = 1; page < totalPages; page++) {
    const data = await fetchPage(page * LIMIT);
    allValues.push.apply(allValues, data.values);
  }

  const agents = [];        // люди-иноагенты
  const organizations = []; // организации и объединения

  for (let i = 0; i < allValues.length; i++) {
    const v = allValues[i];
    const full = (v.field_2_s || "").trim();
    if (!full) continue;

    const type = v.field_7_s || "";

    if (type === TYPE_PHYSICAL) {
      const pseudonym = extractPseudonym(full);
      const fullName = cleanFullName(full, pseudonym);

      agents.push({
        aliases: buildPersonAliases(fullName, pseudonym),
        fullName: fullName,
        pseudonym: pseudonym,
        type: type
      });
    } else {
      organizations.push({
        name: full,
        type: type,
        aliases: buildOrganizationAliases(full)
      });
    }
  }

  // Удаляем полностью идентичные записи (защита от дублей из API).
  const seen = new Set();
  const uniqueAgents = agents.filter(function (a) {
    const key = a.fullName + "|" + a.pseudonym + "|" + JSON.stringify(a.aliases);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });

  const seenOrg = new Set();
  const uniqueOrgs = organizations.filter(function (o) {
    const key = o.name + "|" + o.type;
    if (seenOrg.has(key)) {
      return false;
    }
    seenOrg.add(key);
    return true;
  });

  const out = {
    version: 1,
    updatedAt: new Date().toISOString(),
    data: {
      foreignAgents: uniqueAgents,
      organizations: uniqueOrgs,
      forbiddenOrganizations: [],
      forbiddenWords18: []
    }
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
  console.log("Saved agents:", uniqueAgents.length, "organizations:", uniqueOrgs.length);
}

run().catch(function (e) {
  console.error("Error:", e.message);
});
