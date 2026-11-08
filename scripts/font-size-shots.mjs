import { chromium } from 'playwright';

const shots = '/tmp/font-size-shots';
const run = async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  await page.goto('http://localhost:5179/');
  await page.waitForTimeout(2500);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('group', { name: 'Chat text size', exact: true }).waitFor({ timeout: 15000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${shots}/settings-medium.png` });

  const group = (name) => page.getByRole('group', { name, exact: true });
  await group('Interface text size').getByRole('button', { name: 'Large', exact: true }).click();
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${shots}/settings-interface-large.png` });
  const zoomLarge = await page.evaluate(() => getComputedStyle(document.body).zoom);
  await group('Interface text size').getByRole('button', { name: 'Small', exact: true }).click();
  await page.waitForTimeout(350);
  const zoomSmall = await page.evaluate(() => getComputedStyle(document.body).zoom);
  await page.screenshot({ path: `${shots}/settings-interface-small.png` });

  await group('Composer text size').getByRole('button', { name: 'Large', exact: true }).click();
  await group('Chat text size').getByRole('button', { name: 'Small', exact: true }).click();
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  const composer = await page.locator('textarea').first().evaluate((el) => getComputedStyle(el).fontSize);
  await page.screenshot({ path: `${shots}/app-small-interface.png` });

  // No leftover strip at the edges when the interface is smaller than 100%.
  const body = await page.evaluate(() => {
    const rect = document.body.getBoundingClientRect();
    return { right: rect.right, bottom: rect.bottom, width: innerWidth, height: innerHeight };
  });
  console.log(JSON.stringify({ zoomLarge, zoomSmall, composer, body }, null, 2));
  await browser.close();
};
run().catch((error) => { console.error(error); process.exit(1); });
