import { test, expect } from '@playwright/test';

test.describe('Main Navigation', () => {
  test.beforeEach(async ({ page }) => {
    // Login before each test
    await page.goto('/login', { waitUntil: 'networkidle' });
    await page.fill('input[name="email"]', 'hwalsh@vertexretail.com');
    await page.fill('input[name="password"]', 'Admin1234!');
    await page.click('button[type="submit"]');
    await page.waitForURL('/dashboard');
  });

  test('should navigate to different sections from the sidebar', async ({ page }) => {
    // Navigate to Users
    await page.click('a[href="/users"]');
    await page.waitForURL('/users');
    await expect(page.locator('h1', { hasText: 'Users' })).toBeVisible();

    // Navigate to Support
    await page.click('a[href="/support"]');
    await page.waitForURL('/support');
    await expect(page.locator('h1', { hasText: 'Support' })).toBeVisible();

    // Navigate to Chat
    await page.click('a[href="/chat"]');
    await page.waitForURL('/chat');
    // Ensure we reached the chat page
    await expect(page).toHaveURL('/chat');

    // Navigate to Profile
    await page.click('a[href="/profile"]');
    await page.waitForURL('/profile');
    await expect(page.locator('h1', { hasText: 'Profile' })).toBeVisible();
  });
});
