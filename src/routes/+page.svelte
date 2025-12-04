<script>
    import Map from "../components/Map.svelte";
    import UIOverlay from "../components/UIOverlay.svelte";

    let selectedNode = null;

    function handleNodeSelect(node) {
        selectedNode = node;
    }

    function handleClose() {
        selectedNode = null;
    }
</script>

<main class="relative w-screen h-screen overflow-hidden bg-dark-bg">
    <Map onNodeSelect={handleNodeSelect} {selectedNode} />
    <UIOverlay {selectedNode} onClose={handleClose} />
</main>
