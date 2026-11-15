"""Pipeline del cubo: de recortes de IRSA a planos por epoca y detector.

    epochs.py      regla de 60 dias: a que epoca va cada exposicion
    exposure.py    un recorte en disco -> exposicion limpia en la grilla del campo
    coadd.py       exposiciones de un plano -> coadd, flags por mayoria y cobertura
    flag_table.py  tablas de bits de los archivos -> `flags[]` del campo
    stats.py       estadisticas de un plano, escala de un detector y regiones saturadas

Solo numpy, scipy y astropy; ningun modulo de aca usa la red.
"""
