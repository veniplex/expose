<script>
    import { fly } from "svelte/transition";
    export let selectedNode;
    export let onClose;
</script>

<div
    class="absolute top-0 left-0 w-full h-full pointer-events-none p-6 flex flex-col justify-between"
>
    <!-- Header -->
    <div class="pointer-events-auto flex justify-between items-start">
        <div class="glass-panel p-4">
            <h1
                class="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-purple-500"
            >
                EXPOSE
            </h1>
            <p class="text-sm text-gray-300">
                Exposing Political, Corporate & Elite Networks
            </p>
        </div>
    </div>

    <!-- Sidebar / Details Panel -->
    {#if selectedNode}
        <div
            transition:fly={{ x: 300, duration: 300 }}
            class="pointer-events-auto absolute right-6 top-6 bottom-6 w-80 glass-panel p-6 overflow-y-auto flex flex-col gap-4"
        >
            <div class="flex justify-between items-center">
                <span
                    class="text-xs font-bold uppercase tracking-wider text-gray-400"
                >
                    {selectedNode.type}
                </span>
                <button
                    on:click={onClose}
                    class="text-gray-400 hover:text-white"
                >
                    ✕
                </button>
            </div>

            <h2 class="text-3xl font-bold text-white">{selectedNode.name}</h2>

            {#if selectedNode.type === "company"}
                <div
                    class="inline-block px-3 py-1 rounded-full bg-blue-500/20 text-blue-300 text-sm self-start"
                >
                    {selectedNode.industry}
                </div>
            {:else}
                <div
                    class="inline-block px-3 py-1 rounded-full bg-pink-500/20 text-pink-300 text-sm self-start"
                >
                    {selectedNode.role}
                </div>
            {/if}

            <p class="text-gray-300 leading-relaxed">
                {selectedNode.description}
            </p>

            <div class="mt-4 pt-4 border-t border-glass-border">
                <h3 class="text-sm font-semibold text-gray-400 mb-2">
                    Location
                </h3>
                <div class="flex items-center gap-2 text-sm">
                    <span class="text-gray-300"
                        >Lat: {selectedNode.lat.toFixed(2)}</span
                    >
                    <span class="text-gray-300"
                        >Lng: {selectedNode.lng.toFixed(2)}</span
                    >
                </div>
            </div>

            <div class="mt-auto pt-6">
                <button class="w-full glass-button text-center">
                    View Full Profile
                </button>
            </div>
        </div>
    {/if}

    <!-- Legend / Controls (Bottom Left) -->
    <div class="pointer-events-auto glass-panel p-3 self-start mt-auto">
        <div class="flex items-center gap-4 text-sm">
            <div class="flex items-center gap-2">
                <span class="w-3 h-3 rounded-full bg-blue-500"></span>
                <span>Companies</span>
            </div>
            <div class="flex items-center gap-2">
                <span class="w-3 h-3 rounded-full bg-pink-500"></span>
                <span>Personalities</span>
            </div>
        </div>
    </div>
</div>
