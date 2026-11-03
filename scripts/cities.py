"""The two dioramas. Each is a W x D metre rectangle around `center`, rotated `theta` degrees clockwise so that the
street grid runs along the voxel axes (None: measured from the building footprints at build time)."""

CITIES = {
    "tlv": dict(
        name="Tel Aviv-Yafo",
        name_he="תל אביב-יפו",
        center=(32.0661, 34.7742),  # lat, lon: between the Carmel Market and Rothschild
        W=3900, D=4800,             # across the coast x along it, metres
        theta=None,
        sea=True,
        # camera presets: (label or OSM name, distance m, compass angle of the camera from the target)
        views=[("Azrieli Circular", 700, 230), ("Rothschild Boulevard|שדרות רוטשילד", 320, 200), ("Jaffa Clock Tower", 300, 250),
               ("Old Jaffa, Jaffa Port", 520, 240), ("Habima Square", 300, 210), ("Dizengoff Square (tsina)", 260, 200),
               ("Gordon Beach", 420, 80), ("Neve Tzedek", 380, 220), ("Carmel Market", 300, 230),
               ("Rabin Square", 380, 200), ("Sarona", 420, 220), ("Shalom Meir Tower", 500, 240)],
    ),
    "rehovot": dict(
        name="Rehovot",
        name_he="רחובות",
        center=(31.9015, 34.8100),  # the Moshava centre to the Weizmann Institute
        W=3200, D=3600,
        theta=None,
        sea=False,
        views=[("Weizmann Institute of Science", 900, 210), ("Weizmann House", 260, 220),
               ("Rehovot Railway Station", 400, 230), ("Herzl Street|הרצל", 400, 200)],
    ),
}

FLOOR = 3.2  # metres per storey where only building:levels is known
