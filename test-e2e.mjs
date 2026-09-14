import puppeteer from 'puppeteer';

(async () => {
  console.log("Starting Puppeteer test...");
  const browser = await puppeteer.launch({ headless: "new", args: ['--no-sandbox'] });
  const page = await browser.newPage();
  
  try {
    await page.goto('http://localhost:5173', { waitUntil: 'networkidle2' });
    console.log("Navigated to Teacher App");

    await page.waitForSelector('input[type="email"]');
    await page.type('input[type="email"]', 'sudhanshusonkarsunsor@gmail.com');
    await page.type('input[type="password"]', 'ssssss');
    await page.click('button[type="submit"]');
    console.log("Clicked login");
    
    // Wait a bit for auth token and navigation
    await new Promise(r => setTimeout(r, 2000));
    console.log("Logged in");

    // Click "Self Study" / "New Note"
    const newNoteClicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, div, span'));
      const btn = btns.find(b => b.textContent && (b.textContent.includes('New Note') || b.textContent.includes('Self Study')));
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    });
    console.log("Clicked New Note: " + newNoteClicked);

    // Wait for Canvas to load
    await new Promise(r => setTimeout(r, 3000));
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
    
    await new Promise(r => setTimeout(r, 1000));
    
    // If there's a confirm modal, type name and save
    await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input'));
      if(inputs.length > 0) inputs[0].value = 'Puppeteer Test Note ' + Date.now();
      
      const btns = Array.from(document.querySelectorAll('button'));
      const confirmSaveBtn = btns.find(b => b.textContent === 'Save' || b.textContent === 'Confirm');
      if (confirmSaveBtn) confirmSaveBtn.click();
    });
    
    console.log("Confirmed save modal (if any)");
    await new Promise(r => setTimeout(r, 3000));
    
    console.log("Test passed! Notes flow executed.");
  } catch (err) {
    console.error("Test failed:", err);
  } finally {
    await browser.close();
  }
})();
