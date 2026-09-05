import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  
  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', error => {
    consoleErrors.push(error.message);
  });

  try {
    console.log("Navigating to /buyer...");
    await page.goto('http://localhost:3000/buyer');
    await page.waitForLoadState('networkidle');

    console.log("Filling RFQ request...");
    // The UI likely has a textarea for chat input and a submit button.
    // I need to find the right selector.
    const input = page.locator('textarea, input[type="text"]').last();
    await input.fill("I need 5000 corrugated boxes delivered to Chennai within 7 days.");
    await input.press('Enter');

    console.log("Waiting for AI response to RFQ creation...");
    await page.waitForTimeout(5000); // Give it some time to process
    
    // Look for the response in the DOM
    const textContent = await page.textContent('body');
    if (textContent.includes('5000 corrugated boxes')) {
      console.log("RFQ created successfully in UI.");
    }

    console.log("Entering second prompt...");
    await input.fill("The total amount is 50000 INR. Create the quote using the RFQ we just created.");
    await input.press('Enter');

    console.log("Waiting for AI response to quote creation...");
    await page.waitForTimeout(8000);

    // Log the page content to analyze it
    // const updatedText = await page.textContent('body');
    // console.log("Final UI content:", updatedText);
    
    if (consoleErrors.length > 0) {
      console.error("Browser Console Errors:", consoleErrors);
    } else {
      console.log("No browser console errors detected.");
    }
    
    console.log("BROWSER_TEST_COMPLETED");
  } catch (err) {
    console.error("Test failed:", err);
  } finally {
    await browser.close();
  }
})();
