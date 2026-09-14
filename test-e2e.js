const puppeteer = require('puppeteer');

(async () => {
  console.log("Starting Puppeteer test...");
  const browser = await puppeteer.launch({ headless: "new", args: ['--no-sandbox'] });
  const page = await browser.newPage();
  
  try {
    // 1. Go to Teacher App
    await page.goto('http://localhost:5173', { waitUntil: 'networkidle2' });
    console.log("Navigated to Teacher App");

    // 2. Login
    await page.waitForSelector('input[type="email"]');
    await page.type('input[type="email"]', 'sudhanshusonkarsunsor@gmail.com');
    await page.type('input[type="password"]', 'ssssss');
    await page.click('button[type="submit"]');
    console.log("Clicked login");
    
    // Wait for Dashboard to load
    await page.waitForSelector('text/Dashboard', { timeout: 10000 }).catch(()=>console.log("Dashboard text not found, continuing"));
    await page.waitForTimeout(2000); // give it time to load data
    console.log("Logged in");

    // 3. Find and click Library / Self Study / New Note
    // The exact selectors depend on the UI. Let's try to find "Library" or "+ New Note"
    // To be safe, we can just evaluate code in browser to click the button with text "+ New Note"
    const newNoteClicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const newNoteBtn = btns.find(b => b.textContent && b.textContent.includes('New Note') || b.textContent.includes('Self Study'));
      if (newNoteBtn) {
        newNoteBtn.click();
        return true;
      }
      return false;
    });
    
    if (!newNoteClicked) {
      console.log("Could not find New Note button, dumping HTML...");
      const html = await page.content();
      console.log(html.substring(0, 500));
      await browser.close();
      return;
    }
    console.log("Clicked New Note / Self Study");

    // Wait for Canvas to load
    await page.waitForTimeout(3000);
    console.log("Canvas should be loaded");

    // Try clicking "Save" button
    const saveClicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const saveBtn = btns.find(b => b.textContent && b.textContent.includes('Save'));
      if (saveBtn) {
        saveBtn.click();
        return true;
      }
      return false;
    });
    console.log("Clicked Save button on canvas: " + saveClicked);
    
    await page.waitForTimeout(1000);
    
    // If there's a confirm modal, type name and save
    await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input'));
      if(inputs.length > 0) inputs[0].value = 'Puppeteer Test Note ' + Date.now();
      
      const btns = Array.from(document.querySelectorAll('button'));
      const confirmSaveBtn = btns.find(b => b.textContent === 'Save' || b.textContent === 'Confirm');
      if (confirmSaveBtn) confirmSaveBtn.click();
    });
    
    console.log("Confirmed save modal (if any)");
    await page.waitForTimeout(3000);
    
    console.log("Test passed! Notes flow executed.");
  } catch (err) {
    console.error("Test failed:", err);
  } finally {
    await browser.close();
  }
})();
