import { test, expect } from '@playwright/test';

test.describe('Authentication Flows', () => {
  test('should login successfully with valid credentials', async ({ page }) => {
    await page.goto('/login', { waitUntil: 'networkidle' });

    // Wait for the login form to load
    await expect(page.locator('h1')).toHaveText('Welcome back');

    // Fill in the form
    await page.fill('input[name="email"]', 'hwalsh@vertexretail.com');
    await page.fill('input[name="password"]', 'Admin1234!');

    // Submit the form
    await page.click('button[type="submit"]');

    // Wait for navigation to the dashboard
    await page.waitForURL('/dashboard');
    await expect(page).toHaveURL('/dashboard');
    
    // Check if some dashboard element is visible
    await expect(page.locator('text=Dashboard').first()).toBeVisible();
  });

  test('should show error message with invalid credentials', async ({ page }) => {
    await page.goto('/login', { waitUntil: 'networkidle' });

    await page.fill('input[name="email"]', 'hwalsh@vertexretail.com');
    await page.fill('input[name="password"]', 'WrongPassword!');
    await page.click('button[type="submit"]');

    // The login error message should be visible. We check for a generic error message
    // or specific text based on what the UI returns. 
    // The component displays `serverError` in a red banner.
    await expect(page.locator('.bg-red-50')).toBeVisible();
  });
});
