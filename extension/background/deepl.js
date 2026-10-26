function endpointFor(key, plan) {
  const pro = plan === 'pro' || (plan === 'auto' && !key.trim().endsWith(':fx'));
  return pro ? 'https://api.deepl.com/v2/translate' : 'https://api-free.deepl.com/v2/translate';
}

export async function deeplTranslate(text, { deeplKey, deeplPlan, targetLang }, context = []) {
  if (!deeplKey) throw new Error('DeepL API key not set – open the extension options or pick a local translator.');
  const res = await fetch(endpointFor(deeplKey, deeplPlan), {
    method: 'POST',
    headers: {
      Authorization: `DeepL-Auth-Key ${deeplKey.trim()}`,
      'Content-Type': 'application/json',
    },
    // `context` is read by DeepL to disambiguate but is neither translated nor billed.
    body: JSON.stringify({ text: [text], source_lang: 'ZH', target_lang: targetLang, ...(context.length ? { context: context.join('\n') } : {}) }),
  });
  if (!res.ok) {
    const reason = { 403: 'invalid API key', 456: 'quota exceeded', 429: 'rate limited' }[res.status] ?? 'request failed';
    throw new Error(`DeepL ${res.status}: ${reason}`);
  }
  const data = await res.json();
  return data.translations?.[0]?.text ?? '';
}
