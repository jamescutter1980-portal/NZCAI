// Playwright smoke test against the built SPA served by the Python adapter.
//   python3 -m api.server --seed --static --port 8790 &   then   node smoke.mjs 8790
import { chromium } from 'playwright'

const port = process.argv[2] ?? '8790'
const base = `http://127.0.0.1:${port}`
const exe = process.env.CHROME_PATH
const browser = await chromium.launch(exe ? { executablePath: exe } : {})
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('requestfailed', (r) => { if (r.url().startsWith(base)) errors.push(`${r.url()} ${r.failure()?.errorText}`) })
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('Failed to load resource')) errors.push(m.text()) })

const check = (cond, msg) => { if (!cond) { console.error('FAIL', msg); process.exitCode = 1 } else console.log('ok  ', msg) }

await page.goto(`${base}/#/plan`)
await page.waitForSelector('[data-testid="plan-row"]')
const planRows = await page.locator('[data-testid="plan-row"]').count()
check(planRows >= 9, `plan lists ${planRows} counterparties`)
check(await page.locator('text=accept published').count() > 0, 'a dominant counterparty is routed to accept published')

await page.click('[data-testid="plan-row"] >> nth=0')
await page.waitForSelector('[data-testid="engagement-card"]')
check((await page.locator('h1').textContent()).length > 0, 'dossier opens from the plan')
await page.click('table tr.clickable >> nth=0')
await page.waitForSelector('[role="dialog"]')
check(await page.locator('[role="dialog"] >> text=Factor').count() > 0, 'lineage drawer shows the factor')
await page.click('[role="dialog"] button.close')

await page.goto(`${base}/#/inventory`)
await page.waitForSelector('[data-testid="figure-row"]')
check(await page.locator('[data-testid="figure-row"]').count() > 0, 'inventory lists figures')

await page.goto(`${base}/#/coverage`)
await page.waitForSelector('text=Gates')
const blockers = await page.locator('.blockers li').count()
const ready = await page.locator('text=Ready to submit').count()
check(blockers > 0 || ready > 0, `coverage shows ${blockers} blockers or readiness (${ready})`)
await page.uncheck('[data-testid="boundary-11"]')
await page.waitForSelector('.blockers li')
check(await page.locator('.blockers li').count() > 0, 'taking category 11 out of the boundary lists the C22 blocker')

await page.goto(`${base}/#/review`)
await page.waitForSelector('[data-testid="proposal"]')
const before = await page.locator('[data-testid="proposal"]').count()
await page.click('[data-testid="proposal"] >> nth=0 >> text=Reject')
await page.waitForFunction((n) => document.querySelectorAll('[data-testid="proposal"]').length === n - 1, before)
check(true, 'rejecting a proposal removes it from the queue')

await page.goto(`${base}/#/counterparties`)
await page.waitForSelector('[data-testid="counterparty-row"]')
await page.screenshot({ path: process.env.SHOT ?? 'smoke.png', fullPage: true })

check(errors.length === 0, `no console or page errors (${errors.join('; ')})`)
await browser.close()
