import {
  PROJECT_NAMES, DEVELOPER_NAMES, LOCATIONS, UNIT_TYPES, VIEWS, FINISHING_TYPES,
  CRM_STAGES, CHANNELS, LEAD_NAMES, EMPLOYEE_NAMES, BROKER_COMPANIES,
  BEDROOMS, FLOORS, RELATIVE_DATES, pickFrom,
  budget as budgetVal, areaSqm as areaVal, downPaymentPct as dpPctVal,
  cashDiscountPct as cashPctVal, paymentYears as yearsVal, deliveryYear as deliveryVal,
} from './value-pools.js';

function proj(rng) { return pickFrom(PROJECT_NAMES, rng); }
function dev(rng) { return pickFrom(DEVELOPER_NAMES, rng); }
function loc(rng) { return pickFrom(LOCATIONS, rng); }
function unit(rng) { return pickFrom(UNIT_TYPES, rng); }
function view(rng) { return pickFrom(VIEWS, rng); }
function finish(rng) { return pickFrom(FINISHING_TYPES, rng); }
function stage(rng) { return pickFrom(CRM_STAGES, rng); }
function chan(rng) { return pickFrom(CHANNELS, rng); }
function lead(rng) { return pickFrom(LEAD_NAMES, rng); }
function emp(rng) { return pickFrom(EMPLOYEE_NAMES, rng); }
function broker(rng) { return pickFrom(BROKER_COMPANIES, rng); }
function budget(rng) { return budgetVal(rng); }
function beds(rng) { return pickFrom(BEDROOMS, rng); }
function area(rng) { return areaVal(rng); }
function dpPct(rng) { return dpPctVal(rng); }
function cashPct(rng) { return cashPctVal(rng); }
function years(rng) { return yearsVal(rng); }
function delivery(rng) { return deliveryVal(rng); }
function floor(rng) { return pickFrom(FLOORS, rng); }
function relDate(rng) { return pickFrom(RELATIVE_DATES, rng); }

// Each intent group maps to an array of generator functions; each
// generator takes an rng and returns {text, entities}. `category` is the
// default category tag for entries produced directly from this intent
// (before any franco/mixed/whatsapp/typo derivation is layered on top by
// the pipeline).

export const INTENT_GROUPS = [
  // ---- Informational ask-X intents ----
  { intent: 'ASK_PRICE', category: 'natural_sentences_informational', gens: [
    (r) => { const p = proj(r); return { text: `عايز اعرف سعر ${p}؟`, entities: { project_name: p } }; },
    (r) => { const p = proj(r), u = unit(r); return { text: `كام سعر ال${u.ar} في ${p}؟`, entities: { project_name: p, unit_type: u.key } }; },
    (r) => { const l = loc(r); return { text: `الأسعار في ${l.ar} عاملة إزاي؟`, entities: { location: l.key } }; },
  ]},
  { intent: 'ASK_PRICE_PER_METER', category: 'natural_sentences_informational', gens: [
    (r) => { const p = proj(r); return { text: `سعر المتر كام في ${p}؟`, entities: { project_name: p } }; },
    (r) => { const l = loc(r); return { text: `متوسط سعر المتر في ${l.ar} كام؟`, entities: { location: l.key } }; },
  ]},
  { intent: 'ASK_DOWN_PAYMENT', category: 'natural_sentences_informational', gens: [
    (r) => { const p = proj(r); return { text: `المقدم كام في ${p}؟`, entities: { project_name: p } }; },
    (r) => { const p = proj(r); return { text: `ممكن اعرف نسبة المقدم المطلوبة في ${p}؟`, entities: { project_name: p } }; },
  ]},
  { intent: 'ASK_INSTALLMENT', category: 'natural_sentences_informational', gens: [
    (r) => { const p = proj(r); return { text: `القسط الشهري هيبقى كام في ${p}؟`, entities: { project_name: p } }; },
  ]},
  { intent: 'ASK_PAYMENT_PLAN', category: 'natural_sentences_informational', gens: [
    (r) => { const p = proj(r); return { text: `فيه خطط تقسيط ايه متاحة في ${p}؟`, entities: { project_name: p } }; },
    (r) => { const p = proj(r), y = years(r); return { text: `ممكن اقسط على ${y} سنين في ${p}؟`, entities: { project_name: p, payment_duration_years: y } }; },
  ]},
  { intent: 'ASK_CASH_DISCOUNT', category: 'natural_sentences_informational', gens: [
    (r) => { const p = proj(r); return { text: `لو دفعت كاش هاخد خصم كام في ${p}؟`, entities: { project_name: p } }; },
  ]},
  { intent: 'ASK_MAINTENANCE_FEE', category: 'natural_sentences_informational', gens: [
    (r) => { const p = proj(r); return { text: `الصيانة كام في ${p}؟`, entities: { project_name: p } }; },
  ]},
  { intent: 'ASK_CLUB_FEES', category: 'natural_sentences_informational', gens: [
    (r) => { const p = proj(r); return { text: `اشتراك النادي كام في ${p}؟`, entities: { project_name: p } }; },
  ]},
  { intent: 'ASK_PARKING', category: 'natural_sentences_informational', gens: [
    (r) => { const p = proj(r); return { text: `فيه جراج مع الوحدة في ${p}؟`, entities: { project_name: p } }; },
  ]},
  { intent: 'ASK_DELIVERY_DATE', category: 'natural_sentences_informational', gens: [
    (r) => { const p = proj(r); return { text: `التسليم امتى في ${p}؟`, entities: { project_name: p } }; },
    (r) => { const p = proj(r), y = delivery(r); return { text: `هل التسليم فعلا ${y} في ${p}؟`, entities: { project_name: p, delivery_year: y } }; },
  ]},
  { intent: 'ASK_FINISHING', category: 'natural_sentences_informational', gens: [
    (r) => { const p = proj(r); return { text: `التشطيب نوعه ايه في ${p}؟`, entities: { project_name: p } }; },
  ]},
  { intent: 'ASK_AVAILABILITY', category: 'natural_sentences_informational', gens: [
    (r) => { const p = proj(r), u = unit(r); return { text: `فيه ${u.ar} متاحة دلوقتي في ${p}؟`, entities: { project_name: p, unit_type: u.key } }; },
  ]},
  { intent: 'ASK_LOCATION', category: 'natural_sentences_informational', gens: [
    (r) => { const p = proj(r); return { text: `${p} موقعه فين بالظبط؟`, entities: { project_name: p } }; },
  ]},
  { intent: 'ASK_DEVELOPER', category: 'natural_sentences_informational', gens: [
    (r) => { const p = proj(r); return { text: `مين الشركة المطورة لـ${p}؟`, entities: { project_name: p } }; },
  ]},
  { intent: 'ASK_AREA', category: 'natural_sentences_informational', gens: [
    (r) => { const p = proj(r), u = unit(r); return { text: `مساحة ال${u.ar} كام في ${p}؟`, entities: { project_name: p, unit_type: u.key } }; },
  ]},
  { intent: 'ASK_VIEW', category: 'natural_sentences_informational', gens: [
    (r) => { const p = proj(r); return { text: `فيه فيو بحر ولا جاردن بس في ${p}؟`, entities: { project_name: p } }; },
  ]},
  { intent: 'ASK_FLOOR', category: 'natural_sentences_informational', gens: [
    (r) => { const p = proj(r); return { text: `فيه ادوار متاحة عالية في ${p}؟`, entities: { project_name: p } }; },
  ]},
  { intent: 'ASK_BEDROOMS', category: 'natural_sentences_informational', gens: [
    (r) => { const p = proj(r); return { text: `اكبر عدد غرف متاح في ${p} كام؟`, entities: { project_name: p } }; },
  ]},
  // ---- Request-X intents ----
  { intent: 'REQUEST_BROCHURE', category: 'natural_sentences_informational', gens: [
    (r) => { const p = proj(r); return { text: `ممكن تبعتلي بروشور ${p}؟`, entities: { project_name: p } }; },
  ]},
  { intent: 'REQUEST_PRICE_LIST', category: 'natural_sentences_informational', gens: [
    (r) => { const p = proj(r); return { text: `ابعتلي برايس ليست ${p} لو سمحت`, entities: { project_name: p } }; },
  ]},
  { intent: 'REQUEST_FLOOR_PLAN', category: 'natural_sentences_informational', gens: [
    (r) => { const p = proj(r), u = unit(r); return { text: `عايز اشوف الفلور بلان بتاع ال${u.ar} في ${p}`, entities: { project_name: p, unit_type: u.key } }; },
  ]},
  { intent: 'REQUEST_OFFER', category: 'natural_sentences_informational', gens: [
    (r) => { const p = proj(r); return { text: `ممكن تجهزلي عرض سعر على ${p}؟`, entities: { project_name: p } }; },
  ]},
  { intent: 'REQUEST_QUOTATION', category: 'natural_sentences_informational', gens: [
    (r) => { const p = proj(r), u = unit(r); return { text: `محتاج كوتيشن رسمي لل${u.ar} في ${p}`, entities: { project_name: p, unit_type: u.key } }; },
  ]},
  { intent: 'REQUEST_CALL', category: 'natural_sentences_informational', gens: [
    (r) => { const d = relDate(r); return { text: `ممكن حد يتصل بيا ${d}؟`, entities: { date_time: d } }; },
  ]},
  { intent: 'REQUEST_WHATSAPP', category: 'natural_sentences_informational', gens: [
    (r) => ({ text: `ابعتلي التفاصيل على الواتساب لو سمحت`, entities: { channel: 'whatsapp' } }),
  ]},
  // ---- Search-by-X ----
  { intent: 'SEARCH_BY_BUDGET', category: 'natural_sentences_search_filter', gens: [
    (r) => { const b = budget(r); return { text: `عايز وحدة بميزانية حوالي ${b.toLocaleString('en-US')} جنيه`, entities: { budget_max: b } }; },
  ]},
  { intent: 'SEARCH_BY_AREA', category: 'natural_sentences_search_filter', gens: [
    (r) => { const a = area(r); return { text: `عايز شقة مساحتها ${a} متر`, entities: { unit_area_sqm: a } }; },
  ]},
  { intent: 'SEARCH_BY_UNIT_TYPE', category: 'natural_sentences_search_filter', gens: [
    (r) => { const u = unit(r); return { text: `فيه ${u.ar} متاحة عندكم؟`, entities: { unit_type: u.key } }; },
  ]},
  { intent: 'SEARCH_BY_BEDROOMS', category: 'natural_sentences_search_filter', gens: [
    (r) => { const b = beds(r); return { text: `عايز شقة ${b} غرف`, entities: { bedrooms: b } }; },
  ]},
  { intent: 'SEARCH_BY_DELIVERY_DATE', category: 'natural_sentences_search_filter', gens: [
    (r) => { const y = delivery(r); return { text: `عايز وحدة تسليم ${y}`, entities: { delivery_year: y } }; },
  ]},
  { intent: 'SEARCH_BY_LOCATION', category: 'natural_sentences_search_filter', gens: [
    (r) => { const l = loc(r); return { text: `عايز اشوف مشاريع في ${l.ar}`, entities: { location: l.key } }; },
  ]},
  { intent: 'COMPARE_UNITS', category: 'natural_sentences_search_filter', gens: [
    (r) => { const p = proj(r); return { text: `ممكن تقارن لي بين وحدتين في ${p}؟`, entities: { project_name: p } }; },
  ]},
  { intent: 'COMPARE_PROJECTS', category: 'natural_sentences_search_filter', gens: [
    (r) => { const p1 = proj(r), p2 = proj(r); return { text: `ايه الفرق بين ${p1} و ${p2}؟`, entities: { project_name: p1 } }; },
  ]},
  // ---- Sales / negotiation ----
  { intent: 'BOOK_UNIT', category: 'sales_negotiation_language', gens: [
    (r) => { const p = proj(r), u = unit(r); return { text: `تمام عايز احجز ال${u.ar} دي في ${p}`, entities: { project_name: p, unit_type: u.key } }; },
  ]},
  { intent: 'CANCEL_RESERVATION', category: 'sales_negotiation_language', gens: [
    (r) => { const p = proj(r); return { text: `عايز الغي الحجز بتاعي في ${p}`, entities: { project_name: p } }; },
  ]},
  { intent: 'SCHEDULE_MEETING', category: 'sales_negotiation_language', gens: [
    (r) => { const d = relDate(r); return { text: `نقدر نعمل ميتنج ${d}؟`, entities: { date_time: d } }; },
  ]},
  { intent: 'FOLLOW_UP', category: 'sales_negotiation_language', gens: [
    (r) => { const l = lead(r); return { text: `فيه اي جديد بخصوص طلب ${l}؟`, entities: { lead_name: l } }; },
  ]},
  { intent: 'NEGOTIATE_PRICE', category: 'sales_negotiation_language', gens: [
    (r) => { const p = proj(r); return { text: `ممكن تنزل السعر شوية في ${p}؟`, entities: { project_name: p } }; },
  ]},
  { intent: 'NEGOTIATE_PAYMENT_PLAN', category: 'sales_negotiation_language', gens: [
    (r) => { const y = years(r); return { text: `ممكن تمدد نظام السداد لـ${y} سنين؟`, entities: { payment_duration_years: y } }; },
  ]},
  // ---- Objections ----
  { intent: 'OBJECTION_PRICE_HIGH', category: 'customer_objections', gens: [
    (r) => { const p = proj(r); return { text: `السعر غالي عليا شوية في ${p}`, entities: { project_name: p } }; },
  ]},
  { intent: 'OBJECTION_DOWN_PAYMENT_HIGH', category: 'customer_objections', gens: [
    (r) => { const pct = dpPct(r); return { text: `مقدم ${pct}% كتير عليا`, entities: { down_payment_percent: pct } }; },
  ]},
  { intent: 'OBJECTION_INSTALLMENT_HIGH', category: 'customer_objections', gens: [
    (r) => ({ text: `القسط الشهري تقيل عليا`, entities: {} }),
  ]},
  { intent: 'OBJECTION_DURATION_SHORT', category: 'customer_objections', gens: [
    (r) => { const y = years(r); return { text: `${y} سنين مش كفاية، عايز مدة اطول`, entities: { payment_duration_years: y } }; },
  ]},
  { intent: 'OBJECTION_LOCATION_FAR', category: 'customer_objections', gens: [
    (r) => { const l = loc(r); return { text: `${l.ar} بعيدة عليا شوية`, entities: { location: l.key } }; },
  ]},
  { intent: 'OBJECTION_DEVELOPER_TRUST', category: 'customer_objections', gens: [
    (r) => { const d = dev(r); return { text: `مش متأكد من سمعة ${d} في السوق`, entities: { developer_name: d } }; },
  ]},
  { intent: 'OBJECTION_DELAY_FEAR', category: 'customer_objections', gens: [
    (r) => { const p = proj(r); return { text: `خايف يحصل تأخير في تسليم ${p}`, entities: { project_name: p } }; },
  ]},
  { intent: 'OBJECTION_NEED_TO_THINK', category: 'customer_objections', gens: [
    (r) => ({ text: `هفكر في الموضوع وارجعلك`, entities: {} }),
  ]},
  { intent: 'OBJECTION_NEED_SPOUSE_APPROVAL', category: 'customer_objections', gens: [
    (r) => ({ text: `لازم اتكلم مع مراتي الأول`, entities: {} }),
  ]},
  { intent: 'OBJECTION_NEED_PARTNER_APPROVAL', category: 'customer_objections', gens: [
    (r) => ({ text: `عندي شريك في القرار ده لازم اخد رأيه`, entities: {} }),
  ]},
  { intent: 'OBJECTION_NOT_READY', category: 'customer_objections', gens: [
    (r) => ({ text: `لسه مش قرر خالص، بدور بس`, entities: {} }),
  ]},
  { intent: 'OBJECTION_NO_DOWN_PAYMENT', category: 'customer_objections', gens: [
    (r) => ({ text: `مش معايا مقدم دلوقتي خالص`, entities: {} }),
  ]},
  { intent: 'OBJECTION_WANT_CHEAPER_ALTERNATIVE', category: 'customer_objections', gens: [
    (r) => { const l = loc(r); return { text: `فيه حاجة ارخص في ${l.ar}؟`, entities: { location: l.key } }; },
  ]},
  { intent: 'OBJECTION_WANT_RESALE', category: 'customer_objections', gens: [
    (r) => ({ text: `لو غيرت رأيي بعدين اقدر ابيع الوحدة تاني؟`, entities: {} }),
  ]},
  // ---- Investment ----
  { intent: 'INVESTMENT_INQUIRY', category: 'investment_language', gens: [
    (r) => { const p = proj(r); return { text: `${p} كويس للاستثمار ولا للسكن بس؟`, entities: { project_name: p } }; },
  ]},
  { intent: 'INVESTMENT_ROI_INQUIRY', category: 'investment_language', gens: [
    (r) => { const p = proj(r); return { text: `العائد على الاستثمار كام في ${p}؟`, entities: { project_name: p } }; },
  ]},
  { intent: 'INVESTMENT_RENTAL_INQUIRY', category: 'investment_language', gens: [
    (r) => { const p = proj(r); return { text: `ممكن اأجر الوحدة بعد الاستلام في ${p}؟`, entities: { project_name: p } }; },
  ]},
  { intent: 'INVESTMENT_RESALE_INQUIRY', category: 'investment_language', gens: [
    (r) => { const p = proj(r); return { text: `سعر البيع بعد سنتين هيبقى تقريبا كام في ${p}؟`, entities: { project_name: p } }; },
  ]},
  { intent: 'INVESTMENT_RECOMMENDATION_REQUEST', category: 'investment_language', gens: [
    (r) => { const b = budget(r); return { text: `ايه افضل مشروع للاستثمار بميزانية ${b.toLocaleString('en-US')}؟`, entities: { budget_max: b } }; },
  ]},
  // ---- Broker ----
  { intent: 'BROKER_REGISTER_CLIENT', category: 'broker_language', gens: [
    (r) => { const l = lead(r); return { text: `عايز اسجل عميل جديد اسمه ${l}`, entities: { lead_name: l } }; },
  ]},
  { intent: 'BROKER_COMMISSION_INQUIRY', category: 'broker_language', gens: [
    (r) => ({ text: `نسبة العمولة بتاعتنا كام؟`, entities: {} }),
  ]},
  { intent: 'BROKER_CO_BROKE_INQUIRY', category: 'broker_language', gens: [
    (r) => { const b = broker(r); return { text: `ممكن نعمل كو-بروك مع ${b}؟`, entities: { broker_company: b } }; },
  ]},
  { intent: 'BROKER_CLIENT_STATUS_INQUIRY', category: 'broker_language', gens: [
    (r) => { const l = lead(r); return { text: `عميلي ${l} وصل لمرحلة ايه دلوقتي؟`, entities: { lead_name: l } }; },
  ]},
  // ---- CRM internal ----
  { intent: 'CRM_LEAD_HISTORY_INQUIRY', category: 'crm_internal_language', gens: [
    (r) => { const l = lead(r); return { text: `وريني تاريخ التعاملات مع ${l}`, entities: { lead_name: l } }; },
  ]},
  { intent: 'CRM_ADD_NOTE', category: 'crm_internal_language', gens: [
    (r) => { const l = lead(r); return { text: `ضيف ملاحظة على ${l}: العميل مهتم بس محتاج وقت`, entities: { lead_name: l } }; },
  ]},
  { intent: 'CRM_FOLLOWUP_LIST_INQUIRY', category: 'crm_internal_language', gens: [
    (r) => ({ text: `عندي متابعات ايه النهاردة؟`, entities: {} }),
  ]},
  { intent: 'CRM_SUMMARIZE_LEAD', category: 'crm_internal_language', gens: [
    (r) => { const l = lead(r); return { text: `اديني ملخص سريع عن ${l}`, entities: { lead_name: l } }; },
  ]},
  { intent: 'CRM_RECOMMEND_NEXT_ACTION', category: 'crm_internal_language', gens: [
    (r) => { const l = lead(r); return { text: `اعمل ايه دلوقتي مع ${l}؟`, entities: { lead_name: l } }; },
  ]},
  // ---- Chitchat / ambiguous / unknown ----
  { intent: 'GREETING', category: 'whatsapp_short_messages', gens: [
    (r) => ({ text: `السلام عليكم`, entities: {} }),
    (r) => ({ text: `صباح الخير`, entities: {} }),
    (r) => ({ text: `ازيك عامل ايه`, entities: {} }),
  ]},
  { intent: 'CHITCHAT', category: 'whatsapp_short_messages', gens: [
    (r) => ({ text: `تمام شكرا ليك`, entities: {} }),
    (r) => ({ text: `ok تمام`, entities: {} }),
  ]},
  { intent: 'AMBIGUOUS_REQUEST', category: 'ambiguity_and_clarification', gens: [
    (r) => ({ text: `غير الحالة`, entities: {} }),
    (r) => ({ text: `ابعتله الحاجة اللي اتكلمنا عليها`, entities: {} }),
    (r) => ({ text: `اعمل اللي لازم يتعمل`, entities: {} }),
  ]},
  { intent: 'UNKNOWN', category: 'ambiguity_and_clarification', gens: [
    (r) => ({ text: `عايز حاجة تانية خالص مش متعلقة بده`, entities: {} }),
  ]},
  // ---- System-action intents (ACTIVE AI action language) ----
  { intent: 'CREATE_TASK', category: 'active_ai_action_language', gens: [
    (r) => { const l = lead(r), d = relDate(r); return { text: `اعملي تاسك اتصل بـ${l} ${d}`, entities: { lead_name: l, date_time: d } }; },
  ]},
  { intent: 'CREATE_LEAD', category: 'active_ai_action_language', gens: [
    (r) => { const l = lead(r); return { text: `ضيف ليد جديد اسمه ${l}`, entities: { lead_name: l } }; },
  ]},
  { intent: 'SEND_MESSAGE', category: 'active_ai_action_language', gens: [
    (r) => { const l = lead(r), c = chan(r); return { text: `ابعت رسالة لـ${l} على ${c.ar}`, entities: { lead_name: l, channel: c.key } }; },
  ]},
  { intent: 'UPDATE_LEAD_STAGE', category: 'active_ai_action_language', gens: [
    (r) => { const l = lead(r), s = stage(r); return { text: `غير مرحلة ${l} لـ${s.ar}`, entities: { lead_name: l, crm_stage: s.key } }; },
  ]},
  { intent: 'ASSIGN_LEAD_OWNER', category: 'active_ai_action_language', gens: [
    (r) => { const l = lead(r), e = emp(r); return { text: `حول ${l} لـ${e}`, entities: { lead_name: l, employee_name: e } }; },
  ]},
  { intent: 'UPDATE_CAMPAIGN_STATUS', category: 'active_ai_action_language', gens: [
    (r) => ({ text: `وقف الكامبين النهاردة`, entities: {} }),
  ]},
  { intent: 'SEND_VIA_INTEGRATION', category: 'active_ai_action_language', gens: [
    (r) => { const l = lead(r); return { text: `ابعت بيانات ${l} على النظام الخارجي`, entities: { lead_name: l } }; },
  ]},
  { intent: 'DELEGATE_TO_AI_AGENT', category: 'active_ai_action_language', gens: [
    (r) => { const l = lead(r); return { text: `خلي الـ AI يقرر بنفسه اللي يعمله مع ${l}`, entities: { lead_name: l } }; },
  ]},
  { intent: 'REQUIRE_APPROVAL', category: 'active_ai_action_language', gens: [
    (r) => ({ text: `ارفع الموضوع ده لموافقة المدير`, entities: {} }),
  ]},
  { intent: 'RECORD_PAYMENT', category: 'active_ai_action_language', gens: [
    (r) => { const b = budget(r); return { text: `سجل دفعة بقيمة ${b.toLocaleString('en-US')} جنيه`, entities: { amount_egp: b } }; },
  ]},
  { intent: 'CANCEL_CONTRACT', category: 'active_ai_action_language', gens: [
    (r) => ({ text: `الغي العقد ده خالص`, entities: {} }),
  ]},
  { intent: 'SEARCH_UNITS', category: 'active_ai_action_language', gens: [
    (r) => { const l = loc(r), b = budget(r); return { text: `دورلي على وحدات في ${l.ar} تحت ${b.toLocaleString('en-US')}`, entities: { location: l.key, budget_max: b } }; },
  ]},
  { intent: 'SCORE_LEAD', category: 'active_ai_action_language', gens: [
    (r) => { const l = lead(r); return { text: `قيّم اهتمام ${l} دلوقتي`, entities: { lead_name: l } }; },
  ]},
  { intent: 'COMPARE_PAYMENT_PLANS', category: 'active_ai_action_language', gens: [
    (r) => { const p = proj(r); return { text: `قارن لي خطط السداد المتاحة في ${p}`, entities: { project_name: p } }; },
  ]},
  { intent: 'GET_DELIVERY_STATUS', category: 'active_ai_action_language', gens: [
    (r) => { const p = proj(r); return { text: `ايه حالة التسليم الحالية في ${p}؟`, entities: { project_name: p } }; },
  ]},
  { intent: 'RECALL_MEMORY', category: 'active_ai_action_language', gens: [
    (r) => { const l = lead(r); return { text: `فاكر اخر مرة اتكلمنا فيها مع ${l} كان في ايه؟`, entities: { lead_name: l } }; },
  ]},
  { intent: 'SEARCH_PROJECTS', category: 'active_ai_action_language', gens: [
    (r) => { const l = loc(r); return { text: `اعرضلي مشاريع متاحة في ${l.ar}`, entities: { location: l.key } }; },
  ]},
  { intent: 'GET_PROJECT_DETAILS', category: 'active_ai_action_language', gens: [
    (r) => { const p = proj(r); return { text: `اديني تفاصيل كاملة عن ${p}`, entities: { project_name: p } }; },
  ]},
  { intent: 'GET_PROJECT_PAYMENT_PLANS', category: 'active_ai_action_language', gens: [
    (r) => { const p = proj(r); return { text: `اعرضلي كل خطط السداد المتاحة في ${p}`, entities: { project_name: p } }; },
  ]},
  { intent: 'GET_DEVELOPER_PORTFOLIO', category: 'active_ai_action_language', gens: [
    (r) => { const d = dev(r); return { text: `اعرضلي كل مشاريع ${d}`, entities: { developer_name: d } }; },
  ]},
  { intent: 'GET_PROJECT_FACILITIES', category: 'active_ai_action_language', gens: [
    (r) => { const p = proj(r); return { text: `فيه ايه خدمات في ${p}؟`, entities: { project_name: p } }; },
  ]},
  { intent: 'GET_PROJECT_LOCATION', category: 'active_ai_action_language', gens: [
    (r) => { const p = proj(r); return { text: `ابعتلي لوكيشن ${p} بالظبط`, entities: { project_name: p } }; },
  ]},
];

// Dedicated single-word / very-short-phrase entries (category
// single_word_vocabulary / short_expressions). Written directly rather
// than derived by truncating longer sentences, since naive slicing of
// Arabic sentences produces ungrammatical fragments.
export const SINGLE_WORD_ENTRIES = [
  { intent: 'ASK_PRICE', text: 'السعر؟', entities: {} },
  { intent: 'ASK_PRICE', text: 'بكام؟', entities: {} },
  { intent: 'ASK_DOWN_PAYMENT', text: 'المقدم؟', entities: {} },
  { intent: 'ASK_AVAILABILITY', text: 'متاح؟', entities: {} },
  { intent: 'ASK_AVAILABILITY', text: 'متاحة؟', entities: {} },
  { intent: 'ASK_DELIVERY_DATE', text: 'التسليم؟', entities: {} },
  { intent: 'ASK_FINISHING', text: 'التشطيب؟', entities: {} },
  { intent: 'ASK_LOCATION', text: 'فين؟', entities: {} },
  { intent: 'ASK_VIEW', text: 'الفيو؟', entities: {} },
  { intent: 'ASK_AREA', text: 'المساحة؟', entities: {} },
  { intent: 'GREETING', text: 'أهلا', entities: {} },
  { intent: 'GREETING', text: 'هاي', entities: {} },
  { intent: 'CHITCHAT', text: 'تمام', entities: {} },
  { intent: 'CHITCHAT', text: 'ok', entities: {} },
  { intent: 'CHITCHAT', text: 'شكرا', entities: {} },
];

export const SHORT_EXPRESSION_ENTRIES = [
  { intent: 'ASK_PRICE', text: 'كام سعرها؟', entities: {} },
  { intent: 'ASK_DOWN_PAYMENT', text: 'المقدم قد ايه؟', entities: {} },
  { intent: 'ASK_INSTALLMENT', text: 'كام قسط؟', entities: {} },
  { intent: 'ASK_AVAILABILITY', text: 'لسه متاحة؟', entities: {} },
  { intent: 'ASK_DELIVERY_DATE', text: 'التسليم امتى؟', entities: {} },
  { intent: 'ASK_CASH_DISCOUNT', text: 'خصم الكاش كام؟', entities: {} },
  { intent: 'REQUEST_WHATSAPP', text: 'ابعت واتساب', entities: { channel: 'whatsapp' } },
  { intent: 'REQUEST_CALL', text: 'كلمني بعدين', entities: {} },
  { intent: 'OBJECTION_NEED_TO_THINK', text: 'هفكر وارجعلك', entities: {} },
  { intent: 'OBJECTION_PRICE_HIGH', text: 'غالي شوية', entities: {} },
  { intent: 'GREETING', text: 'ازيك عامل ايه', entities: {} },
  { intent: 'CHITCHAT', text: 'تمام كده تسلم', entities: {} },
];

// Non-actionable variants of system-action-intent phrasing: same topic,
// framed as hypothetical/past/third-party/reporting so the intent may
// still be recognized but no action should fire. Used to train the
// "never assume every request should execute" rule concretely.
export const NON_ACTIONABLE_ACTION_VARIANTS = [
  { intent: 'UPDATE_LEAD_STAGE', gens: [
    (r) => { const l = lead(r), s = stage(r); return { text: `لو ${l} رد هنغير مرحلته لـ${s.ar}، بس لسه ما ردش`, entities: { lead_name: l, crm_stage: s.key } }; },
  ]},
  { intent: 'CANCEL_CONTRACT', gens: [
    (r) => ({ text: `ايه اللي بيحصل لو حد الغى العقد بتاعه؟ سؤال عام بس`, entities: {} }),
  ]},
  { intent: 'RECORD_PAYMENT', gens: [
    (r) => { const b = budget(r); return { text: `العميل قال هيدفع ${b.toLocaleString('en-US')} الشهر الجاي، لسه ما دفعش لحد دلوقتي`, entities: { amount_egp: b } }; },
  ]},
  { intent: 'SEND_MESSAGE', gens: [
    (r) => { const l = lead(r); return { text: `فكرة، ممكن نبعت رسالة لـ${l}؟ عايز رأيك الأول`, entities: { lead_name: l } }; },
  ]},
  { intent: 'ASSIGN_LEAD_OWNER', gens: [
    (r) => { const l = lead(r), e = emp(r); return { text: `${e} كان بيسأل مين المسؤول عن ${l} بس مش طالب تحويل`, entities: { lead_name: l, employee_name: e } }; },
  ]},
];
