<script>
    import { onMount } from "svelte";
    import * as d3 from "d3";
    import * as topojson from "topojson-client";
    import { getAllNodes, getLinks } from "$lib/data";

    export let onNodeSelect;
    export let selectedNode;

    let container;
    let width;
    let height;

    // D3 selections
    let svg;
    let g;
    let globe;
    let linkPath;
    let nodeGroup;
    let countriesPath;

    // Data
    let nodes = [];
    let links = [];

    // Projection
    let projection;
    let path;

    // Reactivity fix: explicitly depend on selectedNode
    $: if (nodeGroup && linkPath && selectedNode !== undefined) {
        updateStyles(selectedNode);
    }

    function updateStyles(currentSelected) {
        console.log("Map: updateStyles called with", currentSelected);

        if (!nodeGroup || !linkPath) return;

        if (!currentSelected) {
            // Reset
            console.log("Map: Resetting styles");
            nodeGroup.style("opacity", 1);
            nodeGroup
                .selectAll("circle")
                .attr("r", 5)
                .attr("stroke", "#fff")
                .attr("stroke-width", 1.5);

            linkPath
                .style("opacity", 0.5)
                .attr("stroke", "rgba(255, 255, 255, 0.2)")
                .attr("stroke-width", 1);
            return;
        }

        const connectedNodeIds = new Set();
        const connectedLinkIds = new Set();

        connectedNodeIds.add(currentSelected.id);

        links.forEach((l) => {
            if (
                l.source.id === currentSelected.id ||
                l.target.id === currentSelected.id
            ) {
                connectedLinkIds.add(l);
                connectedNodeIds.add(l.source.id);
                connectedNodeIds.add(l.target.id);
            }
        });

        console.log("Connected Nodes:", connectedNodeIds);

        // Update Nodes
        nodeGroup.style("opacity", (d) => {
            return connectedNodeIds.has(d.id) ? 1 : 0.3;
        });

        nodeGroup
            .selectAll("circle")
            .attr("r", (d) => (d.id === currentSelected.id ? 8 : 5))
            .attr("stroke", (d) => {
                if (d.id === currentSelected.id) return "#f00"; // Red for selected
                if (connectedNodeIds.has(d.id)) return "#fff";
                return "none";
            })
            .attr("stroke-width", (d) =>
                d.id === currentSelected.id ? 3 : 1.5,
            );

        // Update Links
        linkPath
            .style("opacity", (d) => {
                return connectedLinkIds.has(d) ? 1 : 0.2;
            })
            .attr("stroke", (d) =>
                connectedLinkIds.has(d)
                    ? "#60a5fa"
                    : "rgba(255, 255, 255, 0.2)",
            )
            .attr("stroke-width", (d) => (connectedLinkIds.has(d) ? 2 : 1));
    }

    onMount(async () => {
        const response = await fetch(
            "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json",
        );
        const world = await response.json();
        const countries = topojson.feature(world, world.objects.countries);

        nodes = getAllNodes();
        links = getLinks();

        svg = d3
            .select(container)
            .append("svg")
            .attr("width", "100%")
            .attr("height", "100%")
            .style("background", "#0f172a")
            .on("click", (event) => {
                console.log("Clicked background");
                onNodeSelect(null);
            });

        g = svg.append("g");

        projection = d3
            .geoOrthographic()
            .scale(250)
            .translate([width / 2, height / 2]);

        path = d3.geoPath().projection(projection);

        // Draw Globe
        globe = g
            .append("circle")
            .attr("fill", "#1e293b")
            .attr("stroke", "#334155")
            .attr("stroke-width", "0.5")
            .attr("cx", width / 2)
            .attr("cy", height / 2)
            .attr("r", projection.scale());

        // Draw Countries
        countriesPath = g
            .selectAll("path")
            .data(countries.features)
            .enter()
            .append("path")
            .attr("d", path)
            .attr("fill", "#334155")
            .attr("stroke", "#475569")
            .attr("stroke-width", "0.5")
            .attr("class", "country");

        // Draw Links
        linkPath = g
            .selectAll(".link")
            .data(links)
            .enter()
            .append("path")
            .attr("class", "link")
            .attr("fill", "none")
            .attr("stroke", "rgba(255, 255, 255, 0.2)")
            .attr("stroke-width", 1)
            .on("click", (event) => {
                console.log("Clicked link");
                event.stopPropagation();
            });

        // Draw Nodes
        nodeGroup = g
            .selectAll(".node")
            .data(nodes)
            .enter()
            .append("g")
            .attr("class", "node")
            .style("cursor", "pointer")
            .on("click", (event, d) => {
                console.log("Clicked node", d);
                onNodeSelect(d);
                event.stopPropagation();
            });

        nodeGroup
            .append("circle")
            .attr("r", 5)
            .attr("fill", (d) => (d.type === "company" ? "#3b82f6" : "#f472b6"))
            .attr("stroke", "#fff")
            .attr("stroke-width", 1.5);

        // Add Labels
        nodeGroup
            .append("text")
            .text((d) => d.name)
            .attr("dy", -10)
            .attr("text-anchor", "middle")
            .attr("fill", "#fff")
            .style("font-size", "10px")
            .style("text-shadow", "0 1px 3px rgba(0,0,0,0.8)")
            .style("pointer-events", "none")
            .style("opacity", 0); // Hidden by default

        // Zoom behavior
        const zoom = d3
            .zoom()
            .scaleExtent([0.5, 20]) // Increased max zoom
            .on("zoom", (event) => {
                // transform = event.transform;
                projection.scale(250 * event.transform.k);
                update();
            });

        // Custom Drag behavior for rotation
        const drag = d3.drag().on("drag", (event) => {
            const rotate = projection.rotate();
            const k = 75 / projection.scale();
            projection.rotate([
                rotate[0] + event.dx * k,
                rotate[1] - event.dy * k,
            ]);
            update();
        });

        svg.call(drag);
        svg.call(zoom);

        function update() {
            const currentScale = projection.scale();
            globe.attr("r", currentScale);
            countriesPath.attr("d", path);

            // Update links
            linkPath.attr("d", (d) => {
                const source = [d.source.lng, d.source.lat];
                const target = [d.target.lng, d.target.lat];
                return path({
                    type: "LineString",
                    coordinates: [source, target],
                });
            });

            // Update nodes
            nodeGroup.attr("transform", (d) => {
                const coords = projection([d.lng, d.lat]);
                return `translate(${coords[0]}, ${coords[1]})`;
            });

            // Visibility logic
            nodeGroup.each(function (d) {
                const center = projection.invert([width / 2, height / 2]);
                const distance = d3.geoDistance(center, [d.lng, d.lat]);
                const isVisible = distance <= 1.57;

                const element = d3.select(this);
                if (!isVisible) {
                    element.style("display", "none");
                } else {
                    element.style("display", "block");

                    // Label visibility based on zoom
                    // Show labels if zoom > 2 (approx scale 500)
                    const showLabel = currentScale > 500;
                    element.select("text").style("opacity", showLabel ? 1 : 0);
                }
            });

            linkPath.each(function (d) {
                const center = projection.invert([width / 2, height / 2]);
                const distS = d3.geoDistance(center, [
                    d.source.lng,
                    d.source.lat,
                ]);
                const distT = d3.geoDistance(center, [
                    d.target.lng,
                    d.target.lat,
                ]);

                const element = d3.select(this);
                if (distS > 1.57 && distT > 1.57) {
                    element.style("display", "none");
                } else {
                    element.style("display", "block");
                }
            });
        }

        // Initial update
        update();

        // Resize handler
        const resizeObserver = new ResizeObserver((entries) => {
            for (let entry of entries) {
                width = entry.contentRect.width;
                height = entry.contentRect.height;
                if (projection) {
                    projection.translate([width / 2, height / 2]);
                    globe.attr("cx", width / 2).attr("cy", height / 2);
                    svg.attr("width", width).attr("height", height);
                    update();
                }
            }
        });

        resizeObserver.observe(container);

        return () => {
            resizeObserver.disconnect();
        };
    });
</script>

<div class="w-full h-full" bind:this={container}></div>
