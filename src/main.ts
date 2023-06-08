function startReconnectionService(): void {

    // Throwaway code that serves as a placeholder
    console.log("Starting Reconnection Service...");

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', () => {
        console.log("Key press detected. Stopping Reconnection Service...");
        process.exit(0);
    });
}

startReconnectionService();
