Generate a web page using html and java cs.
I need to be able to upload multiple csv file there.
csd files have two columns: location and number.
Locations are Finnish municipalities. Number is how dark the color should be. Each loaded file should have it's own color.
Build a lookup table (municipalities.js). It matches names to map shapes and includes:
   - Finnish and Swedish names (Helsinki/Helsingfors, Vaasa/Vasa)
   - which region each municipality belongs to
   - old municipalities that merged into current ones (e.g. Jyväskylän mlk → Jyväskylä)
Create 3 or 5 different shades of each color for each file. So files locations will be colored either 3 or 5 colors.
Find the Municipalities_of_Finland_labelled_-_FI.svg and save it to this folder. Color the municipality with a the color: bigger number equals darker color.
Have the Municipalities_of_Finland_labelled_-_FI.svg as a map in the bottom of the webpage, and show the colors there. Also show the number if cursor is placed on top of the municipality.
Make the map max 1000px wide so it's fits to web page.
If you can't find the location, make a simple web check where it should belong. If you can't find right place, then skip this row from file.
when files overlap: Show or hide files with checkboxes; when two visible files overlap, the one higher in the list wins. 