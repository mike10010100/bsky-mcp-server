# Verified Manual Submission Workflow

To ensure that replies are posted correctly and verified, follow these sequential steps using Chrome DevTools.

## Step 1: Navigation and Context Fetching
1.  **Navigate** to the specific post URI (e.g., `https://bsky.app/profile/handle/post/id`).
2.  **Wait** for specific text from the post you are replying to (e.g., the last few words of their post).
3.  **Take a Snapshot** to identify the current `uid`s for interaction.

## Step 2: Initiating the Reply
1.  **Click** the "Reply" button (use the `uid` found in the previous step's snapshot).
2.  **Wait** for the text "Write your reply" to appear in the dialog modal. This confirms the editor is ready.

## Step 3: Entering the Response
1.  **Type** the drafted response into the text box.
2.  **Take a Snapshot** to verify that the full text has been entered into the "Rich-Text Editor" value.

## Step 4: Publishing and Final Verification
1.  **Click** the "Publish reply" button (locate its `uid` in the latest snapshot).
2.  **Wait** for a short duration (e.g., `sleep 3`) to allow the post to process.
3.  **Take a Final Snapshot** of the page.
4.  **Verify** that your reply is visible in the thread list on the page.
