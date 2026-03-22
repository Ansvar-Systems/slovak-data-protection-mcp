/**
 * Seed the ÚOOÚ SR database with sample decisions and guidelines for testing.
 *
 * Includes real ÚOOÚ SR decisions (Slovak Telekom, health data breach, camera systems)
 * and representative guidance documents so MCP tools can be tested without
 * running a full data ingestion pipeline.
 *
 * Usage:
 *   npx tsx scripts/seed-sample.ts
 *   npx tsx scripts/seed-sample.ts --force   # drop and recreate
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

const DB_PATH = process.env["UOOU_SK_DB_PATH"] ?? "data/uoou_sk.db";
const force = process.argv.includes("--force");

const dir = dirname(DB_PATH);
if (!existsSync(dir)) {
  mkdirSync(dir, { recursive: true });
}

if (force && existsSync(DB_PATH)) {
  unlinkSync(DB_PATH);
  console.log(`Deleted existing database at ${DB_PATH}`);
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(SCHEMA_SQL);

console.log(`Database initialised at ${DB_PATH}`);

interface TopicRow {
  id: string;
  name_local: string;
  name_en: string;
  description: string;
}

const topics: TopicRow[] = [
  { id: "consent", name_local: "Súhlas", name_en: "Consent", description: "Získanie, platnosť a odvolanie súhlasu na spracúvanie osobných údajov (čl. 7 GDPR)." },
  { id: "cookies", name_local: "Súbory cookies a sledovacie nástroje", name_en: "Cookies and trackers", description: "Ukladanie a čítanie súborov cookies a sledovacích nástrojov na zariadeniach používateľov (ePrivacy smernica)." },
  { id: "transfers", name_local: "Medzinárodné prenosy osobných údajov", name_en: "International transfers", description: "Prenos osobných údajov do tretích krajín alebo medzinárodným organizáciám (čl. 44-49 GDPR)." },
  { id: "dpia", name_local: "Posúdenie vplyvu na ochranu údajov (DPIA)", name_en: "Data Protection Impact Assessment (DPIA)", description: "Posúdenie rizík pre práva a slobody dotknutých osôb pri spracúvaní s vysokým rizikom (čl. 35 GDPR)." },
  { id: "breach_notification", name_local: "Porušenie ochrany osobných údajov", name_en: "Data breach notification", description: "Oznamovanie porušení ÚOOÚ SR a dotknutým osobám (čl. 33-34 GDPR)." },
  { id: "privacy_by_design", name_local: "Ochrana súkromia už v štádiu návrhu", name_en: "Privacy by design", description: "Integrácia ochrany údajov pri návrhu a predvolené nastavenia (čl. 25 GDPR)." },
  { id: "employee_monitoring", name_local: "Monitorovanie zamestnancov", name_en: "Employee monitoring", description: "Spracúvanie osobných údajov v pracovnoprávnych vzťahoch a monitorovanie zamestnancov." },
  { id: "health_data", name_local: "Zdravotné údaje", name_en: "Health data", description: "Spracúvanie zdravotných údajov — osobitné kategórie s posilnenou ochranou (čl. 9 GDPR)." },
  { id: "children", name_local: "Údaje detí", name_en: "Children's data", description: "Ochrana osobných údajov maloletých v online službách (čl. 8 GDPR)." },
];

const insertTopic = db.prepare(
  "INSERT OR IGNORE INTO topics (id, name_local, name_en, description) VALUES (?, ?, ?, ?)",
);
for (const t of topics) {
  insertTopic.run(t.id, t.name_local, t.name_en, t.description);
}
console.log(`Inserted ${topics.length} topics`);

interface DecisionRow {
  reference: string;
  title: string;
  date: string;
  type: string;
  entity_name: string;
  fine_amount: number | null;
  summary: string;
  full_text: string;
  topics: string;
  gdpr_articles: string;
  status: string;
}

const decisions: DecisionRow[] = [
  {
    reference: "UOOU-SR-2021-3456",
    title: "Rozhodnutie ÚOOÚ SR — Slovak Telekom a.s. (porušenie ochrany údajov)",
    date: "2021-08-25",
    type: "pokuta",
    entity_name: "Slovak Telekom a.s.",
    fine_amount: 300_000,
    summary: "ÚOOÚ SR uložil pokutu 300 000 EUR spoločnosti Slovak Telekom za porušenie ochrany osobných údajov, pri ktorom boli kompromitované údaje asi 75 000 zákazníkov vrátane kontaktných informácií, čísel účtov a informácií o predplatenom balíku.",
    full_text: "Úrad na ochranu osobných údajov Slovenskej republiky (ÚOOÚ SR) uložil pokutu vo výške 300 000 EUR spoločnosti Slovak Telekom a.s. Kontrola úradu zistila, že bezpečnostná zraniteľnosť v systéme riadenia zákazníckych účtov umožnila neoprávnený prístup k osobným a zmluvným údajom asi 75 000 zákazníkov vrátane mien, telefónnych čísel, adries, čísel účtov a informácií o zmluvných balíkoch. Zistené porušenia: (1) Prevádzkovateľ nevykonal primerané technické a organizačné bezpečnostné opatrenia podľa čl. 32 GDPR; (2) Porušenie ochrany údajov nebolo nahlásené ÚOOÚ SR v zákonnej lehote 72 hodín; (3) Dotknuté osoby neboli informované o porušení v primeranej lehote. ÚOOÚ SR nariadil okamžité odstránenie zraniteľnosti a posilnenie bezpečnostných systémov.",
    topics: JSON.stringify(["breach_notification", "privacy_by_design"]),
    gdpr_articles: JSON.stringify(["32", "33", "34"]),
    status: "final",
  },
  {
    reference: "UOOU-SR-2022-1234",
    title: "Rozhodnutie ÚOOÚ SR — Zdravotnícke zariadenie (únik zdravotných údajov)",
    date: "2022-04-18",
    type: "pokuta",
    entity_name: "Nemocnica s.r.o.",
    fine_amount: 200_000,
    summary: "ÚOOÚ SR uložil pokutu 200 000 EUR nemocnici za neoprávnený prístup zdravotníckeho personálu k elektronickým zdravotným záznamom pacientov, za ktorých starostlivosť nezodpovedali, a za absenciu posúdenia vplyvu na ochranu údajov.",
    full_text: "ÚOOÚ SR uložil pokutu vo výške 200 000 EUR nemocnici. Inšpekcia zistila, že zdravotnícky a administratívny personál mal prístup k zdravotným záznamom všetkých pacientov bez ohľadu na to, či sa podieľali na ich liečbe. Zistené porušenia: (1) Systém správy zdravotných záznamov neuplatňoval riadenie prístupu na základe rolí (RBAC), čím sa porušil čl. 9 GDPR vyžadujúci osobitné záruky pre zdravotné údaje; (2) Nebolo vykonané posúdenie vplyvu na ochranu údajov pre systém elektronických zdravotných záznamov; (3) Audítorské záznamy prístupu neboli dostatočne podrobné na odhalenie neoprávneného prezerania. ÚOOÚ SR nariadil revíziu a zlepšenie kontrol prístupu.",
    topics: JSON.stringify(["health_data", "dpia", "privacy_by_design"]),
    gdpr_articles: JSON.stringify(["9", "32", "35"]),
    status: "final",
  },
  {
    reference: "UOOU-SR-2021-5678",
    title: "Rozhodnutie ÚOOÚ SR — Kamerový systém na pracovisku",
    date: "2021-12-10",
    type: "pokuta",
    entity_name: "Výrobný podnik s.r.o.",
    fine_amount: 50_000,
    summary: "ÚOOÚ SR uložil pokutu 50 000 EUR výrobnému podniku za prevádzkovanie kamerového systému v šatniach a oddychových miestnostiach zamestnancov a za neúmernú dobu uchovávania kamerových záznamov.",
    full_text: "ÚOOÚ SR uložil pokutu vo výške 50 000 EUR výrobnému podniku. Kontrola zistila, že kamery boli nainštalované v šatniach, oddychových miestnostiach a jedálni zamestnancov, pričom záznamy sa uchovávali 90 dní namiesto primeraných 72 hodín. Zistené porušenia: (1) Umiestňovanie kamier v priestoroch, kde zamestnanci oprávnene očakávajú súkromie (šatne, oddychové miestnosti), je neúmerným zásahom do ich práv; (2) Doba uchovávania záznamov bola výrazne dlhšia, ako je potrebné na dosiahnutie bezpečnostného účelu; (3) Zamestnanci neboli riadne informovaní o rozsahu a účele kamerového sledovania. ÚOOÚ SR nariadil okamžité odstránenie kamier z citlivých priestorov a skrátenie doby uchovávania.",
    topics: JSON.stringify(["employee_monitoring", "privacy_by_design"]),
    gdpr_articles: JSON.stringify(["5", "13", "25"]),
    status: "final",
  },
  {
    reference: "UOOU-SR-2022-7890",
    title: "Rozhodnutie ÚOOÚ SR — Cookies bez súhlasu (e-shop)",
    date: "2022-10-05",
    type: "upozornenie",
    entity_name: "E-shop s.r.o.",
    fine_amount: 15_000,
    summary: "ÚOOÚ SR uložil pokutu 15 000 EUR prevádzkovateľovi e-shopu za ukladanie marketingových a analytických cookies pred získaním súhlasu používateľov a za sťažené odmietnutie cookies v porovnaní s ich prijatím.",
    full_text: "ÚOOÚ SR uložil pokutu vo výške 15 000 EUR prevádzkovateľovi e-shopu. Kontrola zistila: (1) Marketingové a analytické cookies tretích strán sa ukladali pri návšteve stránky pred tým, ako používateľ mohol vyjadriť súhlas alebo odmietnutie; (2) Rozhranie cookies bannera ponúkalo možnosť 'Prijať všetko' jedným kliknutím, zatiaľ čo odmietnutie si vyžadovalo viacero krokov; (3) Informácie o cookies tretích strán boli neúplné a ťažko zrozumiteľné. ÚOOÚ SR nariadil uvedenie do súladu v lehote 45 dní.",
    topics: JSON.stringify(["cookies", "consent"]),
    gdpr_articles: JSON.stringify(["6", "7"]),
    status: "final",
  },
  {
    reference: "UOOU-SR-2023-2345",
    title: "Rozhodnutie ÚOOÚ SR — Prenos osobných údajov do USA",
    date: "2023-03-22",
    type: "rozhodnutie",
    entity_name: "Marketingová agentúra s.r.o.",
    fine_amount: 25_000,
    summary: "ÚOOÚ SR uložil pokutu 25 000 EUR marketingovej agentúre za prenos osobných údajov klientov do USA prostredníctvom marketingových nástrojov bez príslušných záruk podľa kapitoly V GDPR.",
    full_text: "ÚOOÚ SR uložil pokutu vo výške 25 000 EUR marketingovej agentúre. Kontrola zistila, že agentúra používa marketingové nástroje so servermi v USA a prenáša osobné údaje — e-mailové adresy, behaviorálne údaje a profilované údaje — bez analýzy prenosov alebo uplatňovania štandardných zmluvných doložiek s príslušnými doplňujúcimi technickými opatreniami. ÚOOÚ SR nariadil agentúre preskúmať všetky cezhraničné prenosy a zdokumentovať právny základ každého prenosu alebo prenosy, ktoré nespĺňajú požiadavky, ukončiť.",
    topics: JSON.stringify(["transfers"]),
    gdpr_articles: JSON.stringify(["44", "46"]),
    status: "final",
  },
  {
    reference: "UOOU-SR-2023-4567",
    title: "Rozhodnutie ÚOOÚ SR — Monitorovanie zamestnancov IT systémami",
    date: "2023-06-15",
    type: "pokuta",
    entity_name: "Technologická spoločnosť a.s.",
    fine_amount: 30_000,
    summary: "ÚOOÚ SR uložil pokutu 30 000 EUR technologickej spoločnosti za systematické monitorovanie zamestnancov sledovaním obrazovky a zachytávaním e-mailov bez právneho základu, oznámenia a posúdenia vplyvu.",
    full_text: "ÚOOÚ SR uložil pokutu vo výške 30 000 EUR technologickej spoločnosti. Zistené porušenia: (1) Spoločnosť používala softvér na sledovanie obrazovky a zachytávanie e-mailov zamestnancov bez právneho základu — súhlas zamestnancov nie je platným právnym základom z dôvodu hierarchickej závislosti; (2) Zamestnanci neboli informovaní o rozsahu a charaktere sledovania; (3) Nebolo vykonané posúdenie vplyvu na ochranu údajov pre toto spracúvanie s vysokým rizikom. ÚOOÚ SR nariadil okamžité zastavenie neúmerného sledovania.",
    topics: JSON.stringify(["employee_monitoring", "consent", "dpia"]),
    gdpr_articles: JSON.stringify(["5", "6", "13", "35"]),
    status: "final",
  },
  {
    reference: "UOOU-SR-2022-8901",
    title: "Rozhodnutie ÚOOÚ SR — Banka (neoprávnený prístup k údajom klientov)",
    date: "2022-07-28",
    type: "pokuta",
    entity_name: "Slovenská banka a.s.",
    fine_amount: 80_000,
    summary: "ÚOOÚ SR uložil pokutu 80 000 EUR banke za neoprávnený prístup zamestnancov k osobným a finančným údajom klientov, pre ktorých nemali legitímnu pracovnú potrebu, a za nedostatočné kontroly prístupu.",
    full_text: "ÚOOÚ SR uložil pokutu vo výške 80 000 EUR banke. Interný audit banky odhalil, že zamestnanci z oddelení, ktoré nie sú priamo zapojené do správy klientskych účtov, pristupovali k osobným a finančným údajom klientov. Zistené porušenia: (1) Banka nezaviedla primerané kontroly prístupu na základe princípu nevyhnutnosti — zamestnanci mali prístup k výrazne väčšiemu množstvu údajov, ako je potrebné na výkon ich pracovných povinností; (2) Bezpečnostný systém negeneroval upozornenia pre podozrivé vzory prístupu; (3) Prevádzkovateľ nevykonal posúdenie vplyvu na ochranu údajov pre systémy s vysokým rizikom. ÚOOÚ SR nariadil revíziu a zlepšenie kontrol prístupu.",
    topics: JSON.stringify(["privacy_by_design", "dpia"]),
    gdpr_articles: JSON.stringify(["5", "25", "32", "35"]),
    status: "final",
  },
  {
    reference: "UOOU-SR-2021-6789",
    title: "Rozhodnutie ÚOOÚ SR — Vzdelávacia platforma (údaje detí)",
    date: "2021-05-20",
    type: "upozornenie",
    entity_name: "Vzdelávacia platforma s.r.o.",
    fine_amount: 20_000,
    summary: "ÚOOÚ SR uložil pokutu 20 000 EUR vzdelávacej online platforme za zbieranie údajov detí mladších ako 16 rokov bez overeného súhlasu rodičov a za profilovanie detí na reklamné účely.",
    full_text: "ÚOOÚ SR uložil pokutu vo výške 20 000 EUR vzdelávacej online platforme. Kontrola zistila: (1) Platforma zbierala osobné údaje detí mladších ako 16 rokov bez účinného overenia rodičovského súhlasu — podľa čl. 8 GDPR a slovenského práva je minimálny vek 16 rokov; (2) Behaviorálne údaje detí sa používali na profilovanie na reklamné účely bez platného právneho základu; (3) Informácie o spracúvaní neboli poskytnuté jazykom zrozumiteľným pre deti. ÚOOÚ SR nariadil okamžité ukončenie profilovania detí a uvedenie informácií do súladu s požiadavkami.",
    topics: JSON.stringify(["children", "consent", "privacy_by_design"]),
    gdpr_articles: JSON.stringify(["6", "8", "13"]),
    status: "final",
  },
];

const insertDecision = db.prepare(`
  INSERT OR IGNORE INTO decisions
    (reference, title, date, type, entity_name, fine_amount, summary, full_text, topics, gdpr_articles, status)
  VALUES
    (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertDecisionsAll = db.transaction(() => {
  for (const d of decisions) {
    insertDecision.run(d.reference, d.title, d.date, d.type, d.entity_name, d.fine_amount, d.summary, d.full_text, d.topics, d.gdpr_articles, d.status);
  }
});

insertDecisionsAll();
console.log(`Inserted ${decisions.length} decisions`);

interface GuidelineRow {
  reference: string | null;
  title: string;
  date: string;
  type: string;
  summary: string;
  full_text: string;
  topics: string;
  language: string;
}

const guidelines: GuidelineRow[] = [
  {
    reference: "UOOU-SR-USMER-COOKIES-2022",
    title: "Usmernenie k súborom cookies a podobným sledovacím technológiám",
    date: "2022-07-01",
    type: "usmernenie",
    summary: "Usmernenie ÚOOÚ SR k požiadavkám na súhlas pre súbory cookies a príbuzné sledovacie technológie. Opisuje podmienky platného súhlasu, požiadavky na cookies banner a zabezpečenie rovnako jednoduchého odmietnutia.",
    full_text: "ÚOOÚ SR vydal usmernenie k súborom cookies v súlade s ePrivacy smernicou a GDPR. Kľúčové požiadavky: (1) Súhlas je potrebný pre všetky nepodstatné cookies (marketingové, analytické, profilovacie) pred ich uložením; (2) Platný súhlas musí byť slobodný, konkrétny, informovaný a jednoznačný — 'cookie walls' sú zakázané; (3) Odmietnutie musí byť rovnako jednoduché ako prijatie — banner musí obsahovať tlačidlo 'Odmietnuť všetko' na rovnakej úrovni ako 'Prijať všetko'; (4) Súhlas treba obnovovať najmenej raz ročne; (5) Prevádzkovateľ musí vedieť preukázať, že získal platný súhlas.",
    topics: JSON.stringify(["cookies", "consent"]),
    language: "sk",
  },
  {
    reference: "UOOU-SR-PRIRUCKA-DPIA-2021",
    title: "Príručka k posúdeniu vplyvu na ochranu údajov (DPIA)",
    date: "2021-12-01",
    type: "príručka",
    summary: "Príručka ÚOOÚ SR k vykonávaniu posúdenia vplyvu na ochranu údajov. Opisuje kedy je DPIA povinná, ako ju vykonať a čo zdokumentovať.",
    full_text: "Čl. 35 GDPR ukladá povinnosť vykonať DPIA, keď spracúvanie, najmä s využitím nových technológií, môže viesť k vysokému riziku pre práva a slobody fyzických osôb. DPIA je povinná najmä pre: systematické rozsiahle sledovanie verejne prístupných miest, rozsiahle spracúvanie osobitných kategórií údajov (zdravotné, biometrické), profilovanie s právnymi alebo podobnými účinkami, automatizované rozhodovanie. Kroky DPIA: (1) Systematický opis spracúvania — účely, kategórie údajov, príjemcovia, prenosy, lehoty uchovávania; (2) Posúdenie nevyhnutnosti a primeranosti; (3) Posúdenie rizík — identifikácia hrozieb a posúdenie závažnosti a pravdepodobnosti; (4) Opatrenia na riadenie rizík; (5) Konzultácia s ÚOOÚ SR pri zostatkových vysokých rizikách.",
    topics: JSON.stringify(["dpia", "privacy_by_design"]),
    language: "sk",
  },
  {
    reference: "UOOU-SR-USMER-KAMERY-2020",
    title: "Usmernenie k prevádzkovaniu kamerových systémov",
    date: "2020-11-15",
    type: "usmernenie",
    summary: "Usmernenie ÚOOÚ SR k zákonným podmienkam pre kamerové systémy. Zahŕňa právny základ, miesta, ktoré sa nesmú monitorovať, požiadavky na oznámenia a lehoty uchovávania záznamov.",
    full_text: "Usmernenie ÚOOÚ SR k prevádzkovaniu kamerových systémov vychádza z GDPR a zákona č. 18/2018 Z.z. o ochrane osobných údajov. Právny základ: kamerové sledovanie sa môže opierať o oprávnený záujem (ochrana majetku a osôb) alebo plnenie zmluvy, ale nesmie presahovať nevyhnutné. Miesta, ktoré sa nesmú monitorovať: toalety, šatne, odpočívarne zamestnancov. Oznámenie: jasne viditeľné upozornenia na vstupoch do monitorovaného priestoru. Lehota uchovávania: maximálne 15 dní, výnimočne dlhšie. DPIA: povinná pre rozsiahle kamerové systémy, najmä s analytikou tvárí.",
    topics: JSON.stringify(["employee_monitoring", "dpia", "privacy_by_design"]),
    language: "sk",
  },
  {
    reference: "UOOU-SR-USMER-PORUŠENIE-2021",
    title: "Usmernenie k oznamovaniu porušení ochrany osobných údajov",
    date: "2021-06-10",
    type: "usmernenie",
    summary: "Usmernenie ÚOOÚ SR k postupu pri porušení ochrany osobných údajov. Opisuje povinnosti oznámenia ÚOOÚ SR (72 hodín), oznámenia dotknutým osobám a dokumentovania.",
    full_text: "Porušenie ochrany osobných údajov je porušenie bezpečnosti, ktoré vedie k náhodnému alebo nezákonnému zničeniu, strate, zmene, neoprávnenému sprístupneniu alebo prístupu k osobným údajom. Oznámenie ÚOOÚ SR (čl. 33): každé porušenie, ktoré predstavuje riziko pre práva a slobody, musí byť oznámené ÚOOÚ SR do 72 hodín. Oznámenie musí obsahovať: povahu porušenia, kategórie a počet dotknutých osôb a záznamov, pravdepodobné dôsledky, prijaté alebo plánované opatrenia. Oznámenie dotknutým osobám (čl. 34): pri vysokom riziku musia byť dotknuté osoby informované bez zbytočného odkladu — okrem prípadov, keď boli uplatnené primerané technické ochranné opatrenia (šifrovanie). Dokumentácia: všetky porušenia musia byť zdokumentované interne.",
    topics: JSON.stringify(["breach_notification"]),
    language: "sk",
  },
  {
    reference: "UOOU-SR-METODPOKYN-ZDRAVIE-2022",
    title: "Metodický pokyn k spracúvaniu zdravotných údajov",
    date: "2022-03-01",
    type: "metodický_pokyn",
    summary: "Metodický pokyn ÚOOÚ SR k spracúvaniu zdravotných údajov v súlade s GDPR. Zahŕňa právne základy, riadenie prístupu a požiadavky na bezpečnosť.",
    full_text: "Zdravotné údaje sú osobitnou kategóriou osobných údajov podľa čl. 9 GDPR. Právne základy pre spracúvanie: preventívna medicína, lekárska diagnostika, poskytovanie zdravotnej starostlivosti; verejný záujem v oblasti verejného zdravia; vedecký výskum s príslušnými zárukami; výslovný súhlas dotknutej osoby. Riadenie prístupu: zdravotnícke zariadenia musia zabezpečiť prístup k údajom pacientov na základe princípu nevyhnutnosti — prístup majú len zdravotnícki pracovníci priamo zapojení do starostlivosti o pacienta. Bezpečnosť: silná autentifikácia pre zdravotné systémy, šifrovanie údajov, protokolovanie prístupov. DPIA je povinná pre systémy spracúvajúce zdravotné údaje vo veľkom rozsahu.",
    topics: JSON.stringify(["health_data", "dpia", "privacy_by_design"]),
    language: "sk",
  },
];

const insertGuideline = db.prepare(`
  INSERT INTO guidelines (reference, title, date, type, summary, full_text, topics, language)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertGuidelinesAll = db.transaction(() => {
  for (const g of guidelines) {
    insertGuideline.run(g.reference, g.title, g.date, g.type, g.summary, g.full_text, g.topics, g.language);
  }
});

insertGuidelinesAll();
console.log(`Inserted ${guidelines.length} guidelines`);

const decisionCount = (db.prepare("SELECT count(*) as cnt FROM decisions").get() as { cnt: number }).cnt;
const guidelineCount = (db.prepare("SELECT count(*) as cnt FROM guidelines").get() as { cnt: number }).cnt;
const topicCount = (db.prepare("SELECT count(*) as cnt FROM topics").get() as { cnt: number }).cnt;
const decisionFtsCount = (db.prepare("SELECT count(*) as cnt FROM decisions_fts").get() as { cnt: number }).cnt;
const guidelineFtsCount = (db.prepare("SELECT count(*) as cnt FROM guidelines_fts").get() as { cnt: number }).cnt;

console.log(`\nDatabase summary:`);
console.log(`  Topics:         ${topicCount}`);
console.log(`  Decisions:      ${decisionCount} (FTS entries: ${decisionFtsCount})`);
console.log(`  Guidelines:     ${guidelineCount} (FTS entries: ${guidelineFtsCount})`);
console.log(`\nDone. Database ready at ${DB_PATH}`);

db.close();
