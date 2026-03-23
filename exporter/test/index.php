<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Historical Map Viewer</title>
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.7.1/dist/leaflet.css" />
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/noUiSlider/15.8.1/nouislider.min.css">
    <style>
        #map { position: absolute; top: 0; bottom: 0; right: 0; left: 0; margin: 0; }
        
        /* Slider Container - Bottom Left */
        .slider-container {
            position: absolute;
            bottom: 20px;
            left: 20px;
            z-index: 1000;
            width: 300px;
            background-color: rgba(255, 255, 255, 0.9);
            padding: 10px;
            border-radius: 8px;
            display: none;
        }

        /* Toggle Button - Bottom Right */
        .toggle-button {
            position: absolute;
            bottom: 20px;
            right: 20px;
            z-index: 1001;
            width: 40px;
            height: 40px;
            background-color: white;
            border: 2px solid rgba(0, 0, 0, 0.2);
            border-radius: 5px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            text-align: center;
        }
        
        /* Spinner Overlay */
        .spinner-overlay {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.5);
            display: none; /* Hidden initially */
            align-items: center;
            justify-content: center;
            z-index: 1002;
        }
        
        .spinner-overlay div {
            width: 40px;
            height: 40px;
            border: 5px solid #ffffff;
            border-top: 5px solid #3498db;
            border-radius: 50%;
            animation: spin 1s linear infinite;
        }

        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
    </style>
</head>
<body>
    <div id="map"></div>

    <script src="https://unpkg.com/leaflet@1.7.1/dist/leaflet.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/noUiSlider/15.8.1/nouislider.min.js"></script>
    <script>
        const map = L.map('map').setView([35.345, 33.233], 17);

        // Basic tile layer for reference
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 21 }).addTo(map);

        const dates = [
            "2008-04-23", "2008-07-09", "2010-07-02", "2011-06-20", "2012-07-29", "2012-12-31",
            "2013-04-29", "2013-10-24", "2013-10-30", "2014-03-21", "2014-10-07", "2015-01-24",
            "2015-03-10", "2015-03-22", "2015-04-05", "2015-04-13", "2016-04-05", "2016-07-24",
            "2016-06-07", "2016-09-28", "2016-11-24", "2017-04-11", "2018-04-06", "2018-04-16",
            "2018-05-05", "2019-06-23", "2019-08-10", "2019-08-13", "2019-08-15", "2019-08-26",
            "2019-12-02", "2020-04-13", "2020-05-21", "2020-06-09", "2020-10-16", "2022-01-09",
            "2022-06-11", "2023-05-14", "2024-07-16"
        ];

        const dateValues = dates.map(date => new Date(date).getTime());

        // Dynamically create spinner overlay, slider, and toggle button
        const spinnerOverlay = document.createElement('div');
        spinnerOverlay.className = 'spinner-overlay';
        spinnerOverlay.innerHTML = '<div></div>';
        map.getContainer().appendChild(spinnerOverlay);

        const sliderContainer = document.createElement('div');
        sliderContainer.className = 'slider-container';
        sliderContainer.id = 'sliderContainer';
        map.getContainer().appendChild(sliderContainer);

        const timeSlider = document.createElement('div');
        timeSlider.id = 'slider-time';
        sliderContainer.appendChild(timeSlider);

        const toggleSliderButton = document.createElement('div');
        toggleSliderButton.className = 'toggle-button';
        toggleSliderButton.innerHTML = '&#9881;';
        map.getContainer().appendChild(toggleSliderButton);

      // Prevent map from moving when interacting with the slider
        L.DomEvent.disableClickPropagation(sliderContainer);
        L.DomEvent.disableScrollPropagation(sliderContainer);
		
		
        // Initialize the slider
        noUiSlider.create(timeSlider, {
            start: [dateValues[1]],
            range: {
                min: dateValues[0],
                max: dateValues[dateValues.length - 1]
            },
            step: 1,
            connect: 'lower',
            tooltips: {
                to: value => new Date(+value).toISOString().split('T')[0],
                from: value => Date.parse(value)
            },
            pips: {
                mode: 'values',
                values: dateValues,
                density: 4,
                format: {
                    to: value => new Date(value).toISOString().split('T')[0]
                }
            }
        });

        // Toggle slider visibility button
        toggleSliderButton.addEventListener('click', () => {
            sliderContainer.style.display = sliderContainer.style.display === 'none' ? 'block' : 'none';
        });

        // Show toggle button at zoom 17 or above
        map.on('zoomend', () => {
            if (map.getZoom() >= 17) {
                toggleSliderButton.style.display = 'flex';
            } else {
                toggleSliderButton.style.display = 'none';
                sliderContainer.style.display = 'none';
            }
        });

        // Fetch and update tiles when slider changes
        let selectedDate = dates[1];
        timeSlider.noUiSlider.on('update', (values, handle) => {
            const sliderValue = +values[handle];
            selectedDate = dates.reduce((closest, currentDate) => {
                return Math.abs(new Date(currentDate).getTime() - sliderValue) < 
                       Math.abs(new Date(closest).getTime() - sliderValue) ? currentDate : closest;
            });
            fetchHistoricalTiles();
        });

        // Function to show spinner
        function showSpinner() {
            spinnerOverlay.style.display = 'flex';
        }

        // Function to hide spinner
        function hideSpinner() {
            spinnerOverlay.style.display = 'none';
        }

        // Fetch historical tiles based on selected date
        function fetchHistoricalTiles() {
			
			
            const bounds = map.getBounds();
            const zoomLevel = map.getZoom();

 if (sliderContainer.style.display === 'none') return;
 
            if (zoomLevel < 17) return;

            showSpinner();

            const data = {
                date: selectedDate,
                bounds: {
                    north: bounds.getNorth(),
                    south: bounds.getSouth(),
                    east: bounds.getEast(),
                    west: bounds.getWest(),
                },
                zoom: zoomLevel,
            };

            fetch('http://localhost:3000/tiles', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data),
            })
            .then(response => response.json())
            .then(tiles => {
                historicalLayerGroup.clearLayers();
                tiles.forEach(tile => {
                    const tileBounds = L.latLngBounds(
                        [tile.bounds.south, tile.bounds.west],
                        [tile.bounds.north, tile.bounds.east]
                    );
                    L.imageOverlay(tile.url, tileBounds, { opacity: 0.9 }).addTo(historicalLayerGroup);
                });
                hideSpinner();
            })
            .catch(error => {
                console.error('Error fetching tiles:', error);
                hideSpinner();
            });
        }

        // Initial map load and event bindings
        let historicalLayerGroup = L.layerGroup().addTo(map);
        map.on('moveend', fetchHistoricalTiles);
        map.on('zoomend', fetchHistoricalTiles);

    </script>
</body>
</html>
