import { test, expect } from '@playwright/test';

// Use a shared state or just login before each test for dashboard
test.describe('Dashboard access', () => {
  test.beforeEach(async ({ page }) => {
    // Login before each test
    await page.goto('/login', { waitUntil: 'networkidle' });
    await page.fill('input[name="email"]', 'hwalsh@vertexretail.com');
    await page.fill('input[name="password"]', 'Admin1234!');
    await page.click('button[type="submit"]');
    await page.waitForURL('/dashboard');
  });

  test('should load the dashboard and display user data', async ({ page }) => {
    await expect(page).toHaveURL('/dashboard');
    
    // Check if the dashboard loads some basic widgets or headings
    // e.g., Welcome message, stats, etc.
    // We'll look for "Dashboard" header and the user's name or org name
    await expect(page.locator('text=Vertex Retail Corp').first()).toBeVisible();
  });
});
