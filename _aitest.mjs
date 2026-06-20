import { chromium } from 'playwright-core'
const EXEC = '/Users/brettlamy/Library/Caches/ms-playwright/chromium-1169/chrome-mac/Chromium.app/Contents/MacOS/Chromium'
const BASE = 'https://collaborative-ai-editor.brett-lamy.workers.dev'
const browser = await chromium.launch({ executablePath: EXEC, headless: true })
const page = await browser.newPage({ viewport: { width: 1300, height: 900 } })
let err=null; page.on('console',m=>{const t=m.text(); if(/multiple versions|RUN_ERROR|agent-run-error/i.test(t)&&!err)err=t.slice(0,160)})
const ws='aimd'+Math.floor(Date.now()/1000)
await page.goto(`${BASE}/w/${ws}/n1`,{waitUntil:'domcontentloaded'})
await page.waitForSelector('.gb-content .ProseMirror',{timeout:25000}); await page.waitForTimeout(3000)
await page.locator('.gb-content .ProseMirror').click()
await page.keyboard.type('Seed.',{delay:5}); await page.waitForTimeout(1200)
await page.locator('textarea').first().click()
await page.keyboard.type('Add a markdown table with columns Fruit and Price and 3 rows. Then add a collapsible section titled Notes containing one sentence.',{delay:2})
await page.keyboard.press('Enter')
let ok=false
for(let i=0;i<50;i++){await page.waitForTimeout(1000); const t=await page.locator('.gb-content table').count(); if(t>0){ok=true;break} if(err)break}
const info=await page.evaluate(()=>{
  const pm=document.querySelector('.gb-content .ProseMirror')
  return {
    tables: pm.querySelectorAll('table').length,
    expandables: pm.querySelectorAll('.gb-expandable').length,
    // literal leakage: a paragraph containing raw table pipes or {% tags
    literalPipeRows: [...pm.querySelectorAll('p')].filter(p=>/\|\s*---\s*\|/.test(p.textContent)).length,
    literalTags: [...pm.querySelectorAll('p')].filter(p=>/\{%|<details>/.test(p.textContent)).length,
  }
})
console.log(JSON.stringify({...info, err}))
await page.screenshot({path:'_ai.png'})
await browser.close()
